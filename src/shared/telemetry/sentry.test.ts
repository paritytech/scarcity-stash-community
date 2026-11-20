// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as Log from './log';
import type * as Sentry from './sentry';

const h = vi.hoisted(() => ({
  init: [] as unknown[],
  spans: [] as {
    name: string;
    op?: string;
    startTime?: number;
    ended?: number;
    status?: unknown;
    attributes?: Record<string, unknown>;
  }[],
  crumbs: [] as unknown[],
  events: [] as unknown[],
  tags: [] as unknown[],
  attributes: [] as unknown[],
  fingerprints: [] as unknown[],
  eventTags: [] as Record<string, string>[],
  replayId: undefined as string | undefined,
}));
vi.mock('@sentry/react', () => {
  const integration = (name: string) => () => ({ name });
  return {
    init: (o: unknown) => h.init.push(o),
    eventFiltersIntegration: integration('EventFilters'),
    functionToStringIntegration: integration('FunctionToString'),
    globalHandlersIntegration: integration('GlobalHandlers'),
    linkedErrorsIntegration: integration('LinkedErrors'),
    dedupeIntegration: integration('Dedupe'),
    httpContextIntegration: integration('HttpContext'),
    browserSessionIntegration: integration('BrowserSession'),
    consoleLoggingIntegration: (options: unknown) => ({ name: 'ConsoleLogs', options }),
    replayIntegration: (options: unknown) => ({ name: 'Replay', options }),
    getReplay: () => (h.replayId ? { getReplayId: () => h.replayId } : undefined),
    setAttributes: (a: unknown) => h.attributes.push(a),
    makeBrowserOfflineTransport: (f: unknown) => f,
    makeFetchTransport: () => undefined,
    setTags: (t: unknown) => h.tags.push(t),
    startInactiveSpan: (o: { name: string; op?: string; startTime?: number; attributes?: Record<string, unknown> }) => {
      const span = { ...o, ended: undefined as number | undefined, status: undefined as unknown };
      h.spans.push(span);
      return {
        end: (t: number) => {
          span.ended = t;
        },
        setStatus: (s: unknown) => {
          span.status = s;
        },
      };
    },
    withActiveSpan: (_s: unknown, cb: () => void) => cb(),
    addBreadcrumb: (c: unknown) => h.crumbs.push(c),
    withScope: (
      cb: (scope: {
        setTags: (t: unknown) => void;
        setTag: (k: string, v: string) => void;
        setFingerprint: (f: unknown) => void;
      }) => void,
    ) => {
      const tags: Record<string, string> = {};
      h.eventTags.push(tags);
      cb({
        setTags: (t) => h.tags.push(t),
        setTag: (k, v) => {
          tags[k] = v;
        },
        setFingerprint: (f) => h.fingerprints.push(f),
      });
    },
    captureEvent: (e: unknown) => h.events.push(e),
    flush: async () => true,
  };
});

import { scrubText } from './scrub';

let addSink: typeof Log.addSink;
let flushTelemetry: typeof Log.flushTelemetry;
let journey: typeof Log.journey;
let pageVisibility: typeof Log.pageVisibility;
let sentrySink: typeof Sentry.sentrySink;

// Fresh modules per test: no journey, record or sink carries over.
beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  ({ addSink, flushTelemetry, journey, pageVisibility } = await import('./log'));
  ({ sentrySink } = await import('./sentry'));
  for (const k of ['init', 'spans', 'crumbs', 'events', 'tags', 'attributes', 'fingerprints', 'eventTags'] as const)
    h[k].length = 0;
  h.replayId = undefined;
  addSink(sink());
});

afterEach(() => {
  vi.useRealTimers();
});

const sink = () =>
  sentrySink({
    dsn: 'https://k@o1.ingest.de.sentry.io/2',
    site: 'stash.paseo',
    release: 'abc1234',
    hostKind: 'ios',
    network: 'paseo',
  });

type LogHook = (log: { level: string; message: string; attributes?: Record<string, unknown> }) => unknown;
const logHook = (): LogHook => (h.init[0] as { beforeSendLog: LogHook }).beforeSendLog;

describe('the Sentry sink', () => {
  it('initialises the SDK with only the listed integrations and user info off', () => {
    expect(h.init[0]).toMatchObject({
      environment: 'stash.paseo',
      release: 'abc1234',
      defaultIntegrations: false,
      tracesSampleRate: 1,
      dataCollection: { userInfo: false },
    });
    const names = (h.init[0] as { integrations: { name: string }[] }).integrations.map((i) => i.name);
    expect(names).toContain('GlobalHandlers');
    expect(names).not.toContain('Breadcrumbs');
    expect(h.tags[0]).toMatchObject({ 'stash.host': 'ios', 'stash.site': 'stash.paseo' });
  });

  it('makes a journey a root span and each step a child covering the wait before it', () => {
    const j = journey('mint', { credit: '0xab' });
    vi.advanceTimersByTime(1_200);
    j.step('proof fetched');
    vi.advanceTimersByTime(800);
    j.done();
    flushTelemetry();
    const [root, step] = h.spans;
    expect(root).toMatchObject({ name: 'mint', op: 'stash.mint', attributes: { 'stash.credit': '0xab' } });
    expect(step).toMatchObject({ name: 'proof fetched', op: 'stash.step' });
    expect(step!.startTime).toBe(root!.startTime);
    expect(Math.round((step!.ended! - step!.startTime!) * 1000)).toBe(1_200);
    expect(root!.status).toEqual({ code: 1 });
    expect(Math.round((root!.ended! - root!.startTime!) * 1000)).toBe(2_000);
    expect(h.crumbs).toHaveLength(3);
    expect(h.events).toHaveLength(0);
  });

  it('sends one event for a failure, grouped by journey, step, kind and reason, with the recent records', () => {
    const j = journey('mint', { credit: '0xcd' });
    j.step('submitted');
    j.fail('fee', 'Token.FundsUnavailable', { detail: 'raw' });
    flushTelemetry();
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({ message: 'mint failed at failed', level: 'error', extra: { detail: 'raw' } });
    expect(h.fingerprints[0]).toEqual(['mint', 'failed', 'failed', 'fee', 'Token.FundsUnavailable']);
    expect((h.events[0] as { extra: { recent: string[] } }).extra.recent.length).toBe(3);
    expect(h.spans[0]!.status).toEqual({ code: 2, message: 'fee' });
  });

  it('records the page going hidden as a crumb, never an event', () => {
    const j = journey('mint');
    j.step('submitted');
    flushTelemetry();
    const before = h.crumbs.length;
    pageVisibility(true);
    flushTelemetry();
    expect(h.events).toHaveLength(0);
    expect(h.crumbs.length).toBeGreaterThanOrEqual(before);
    j.done();
  });

  it('reports a stall as a warning and keeps the journey open', () => {
    const j = journey('read');
    j.step('purse found', {}, 2_000);
    vi.advanceTimersByTime(2_001);
    flushTelemetry();
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({ level: 'warning', message: 'read stalled at purse found' });
    expect(h.spans[0]!.ended).toBeUndefined();
    j.done();
    flushTelemetry();
    expect(h.spans[0]!.ended).toBeDefined();
  });
});

describe('the Sentry sink, beyond the journeys', () => {
  it("sends the app's warnings and errors as logs, never a record's own line, and scrubbed", () => {
    const names = (h.init[0] as { integrations: { name: string; options?: unknown }[] }).integrations;
    expect(names.find((i) => i.name === 'ConsoleLogs')?.options).toEqual({ levels: ['warn', 'error'] });
    expect(logHook()({ level: 'warn', message: '[read ef0234c5] failed FAILED +0ms kind=fee' })).toBeNull();
    expect(logHook()({ level: 'warn', message: '[mint 4c5:mint] submitted +0ms' })).toBeNull();
    const secret = `0x${'ab'.repeat(64)}`;
    expect(
      logHook()({ level: 'warn', message: `[chain] read failed: ${secret}`, attributes: { arg: secret } }),
    ).toEqual({
      level: 'warn',
      message: '[chain] read failed: [secret removed]',
      attributes: { arg: '[secret removed]' },
    });
  });

  it('keeps the last minute of the screen, masked, for failures only', () => {
    const init = h.init[0] as {
      integrations: { name: string; options?: unknown }[];
      replaysSessionSampleRate: number;
      replaysOnErrorSampleRate: number;
    };
    expect(init.integrations.find((i) => i.name === 'Replay')?.options).toEqual({
      maskAllText: true,
      maskAllInputs: true,
      blockAllMedia: true,
    });
    expect(init.replaysSessionSampleRate).toBe(0);
    expect(init.replaysOnErrorSampleRate).toBe(1);
  });

  it('names the replay on a failure, so its last minute is sent with it', () => {
    h.replayId = 'r1';
    const j = journey('mint');
    j.fail('fee', 'Token.FundsUnavailable');
    flushTelemetry();
    expect(h.eventTags.at(-1)).toEqual({ replayId: 'r1' });
  });

  it('tags the phone it came from, on events, spans and logs alike', () => {
    expect(h.tags[0]).toMatchObject({ 'stash.network': 'paseo', 'stash.os': expect.any(String) });
    expect(h.attributes[0]).toEqual(h.tags[0]);
  });

  it("reads an Android phone's model and real system version when the browser gives them", async () => {
    vi.useRealTimers();
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 Chrome/141.0.0.0 Mobile Safari/537.36',
      hardwareConcurrency: 8,
      deviceMemory: 4,
      connection: { effectiveType: '4g' },
      userAgentData: { getHighEntropyValues: async () => ({ model: 'Pixel 9', platformVersion: '16.0.0' }) },
    });
    vi.stubGlobal('screen', { width: 412, height: 915 });
    vi.stubGlobal('devicePixelRatio', 2.625);
    h.tags.length = 0;
    h.attributes.length = 0;
    sink();
    expect(h.tags[0]).toMatchObject({
      'stash.os': 'Android',
      'stash.os_version': '10',
      'stash.screen': '412x915@2.625',
      'stash.cores': '8',
      'stash.memory': '4GB',
      'stash.connection': '4g',
    });
    await vi.waitFor(() => expect(h.tags[1]).toEqual({ 'stash.model': 'Pixel 9', 'stash.os_version': '16.0.0' }));
    expect(h.attributes[1]).toEqual(h.tags[1]);
    vi.unstubAllGlobals();
  });
});

describe('the scrub', () => {
  it('removes what looks like a phrase or a secret key and leaves hashes alone', () => {
    const phrase = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
    expect(scrubText(`Seed: ${phrase}.`)).toBe('Seed: [phrase removed].');
    expect(scrubText(`0x${'ab'.repeat(64)}`)).toBe('[secret removed]');
    expect(scrubText(`0x${'ab'.repeat(32)}`)).toBe(`0x${'ab'.repeat(32)}`);
    expect(scrubText('a few words only')).toBe('a few words only');
  });
  it("removes a socket address's query and any credential in an address, and leaves the rest of it", () => {
    const token = 'ab'.repeat(32);
    expect(scrubText(`websocket error (ws://127.0.0.1:60825/?t=${token})`)).toBe(
      'websocket error (ws://127.0.0.1:60825/?[query removed])',
    );
    expect(scrubText(`GET https://x.example/a?token=${token}&page=2`)).toBe(
      'GET https://x.example/a?token=[removed]&page=2',
    );
    expect(scrubText('https://app.paseo.li/?frame=1')).toBe('https://app.paseo.li/?frame=1');
  });
});
