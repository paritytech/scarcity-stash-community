// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// The Sentry sink: a journey is a root span and each step a child span and a
// breadcrumb; a failure or a stall is one event with the last records and the
// last minute of the screen, masked. Spans and logs go in batches, so nothing
// here blocks a flow. It loads only in a build with the flag, inside a host,
// with a DSN, once the host granted the ingest domain.

import * as Sentry from '@sentry/react';

import { isRecordLine, line } from './consoleSink';
import { deviceId, recentRecords, session } from './log';
import type { Sink, StepRecord } from './record';
import { scrubText, scrubValue } from './scrub';

export interface SentrySinkOptions {
  dsn: string;
  /** The site the build runs as: the Sentry environment. */
  site: string;
  /** The commit the build came from: the Sentry release. */
  release: string;
  /** ios, android, or host for any other container. */
  hostKind: string;
  /** The network the site runs on: paseo or previewnet. */
  network: string;
}

/** A journey left open longer than this is ended as abandoned. */
const ABANDON_MS = 15 * 60_000;
/** Records sent with a failure or a stall, for context. */
const CONTEXT_RECORDS = 40;
/** Sentry drops a tag longer than this. */
const TAG_MOST = 200;

const seconds = (ms: number): number => ms / 1000;

/** What some browsers add to `navigator`: Chromium on Android has them all,
 *  WebKit on iOS none. */
interface NavigatorHints {
  deviceMemory?: number;
  connection?: { effectiveType?: string };
  userAgentData?: {
    getHighEntropyValues?: (hints: string[]) => Promise<{ model?: string; platformVersion?: string }>;
  };
}

/** The system and its version as the page's user agent states them. An
 *  Android browser states a fixed version; the model hints carry the real one. */
function osOf(ua: string): { os: string; version?: string } {
  const ios = /\bOS (\d+)_(\d+)(?:_(\d+))? like Mac OS X/.exec(ua);
  if (ios) return { os: 'iOS', version: ios.slice(1).filter(Boolean).join('.') };
  const android = /Android (\d+(?:\.\d+)*)/.exec(ua);
  if (android) return { os: 'Android', version: android[1] };
  const mac = /Mac OS X (\d+)[._](\d+)/.exec(ua);
  if (mac) return { os: 'macOS', version: `${mac[1]!}.${mac[2]!}` };
  const windows = /Windows NT (\d+\.\d+)/.exec(ua);
  if (windows) return { os: 'Windows', version: windows[1] };
  return { os: ua.includes('Linux') ? 'Linux' : 'unknown' };
}

/** What the page can learn about the phone, read once as the sink joins. What
 *  a browser does not expose is left out. */
function deviceTags(network: string): Record<string, string> {
  const nav = navigator as Navigator & NavigatorHints;
  const { os, version } = osOf(nav.userAgent);
  const tags: Record<string, string> = { 'stash.network': network, 'stash.os': os };
  if (version) tags['stash.os_version'] = version;
  if (typeof screen !== 'undefined')
    tags['stash.screen'] = `${String(screen.width)}x${String(screen.height)}@${String(devicePixelRatio)}`;
  if (nav.hardwareConcurrency) tags['stash.cores'] = String(nav.hardwareConcurrency);
  if (nav.deviceMemory) tags['stash.memory'] = `${String(nav.deviceMemory)}GB`;
  if (nav.connection?.effectiveType) tags['stash.connection'] = nav.connection.effectiveType;
  return tags;
}

/** The phone's model and real system version, where the browser gives them.
 *  They come later than the rest, and join whatever is sent after. */
function askModel(join: (tags: Record<string, string>) => void): void {
  const hints = (navigator as Navigator & NavigatorHints).userAgentData;
  if (!hints?.getHighEntropyValues) return;
  hints.getHighEntropyValues(['model', 'platformVersion']).then(
    ({ model, platformVersion }) => {
      const tags: Record<string, string> = {};
      if (model) tags['stash.model'] = model;
      if (platformVersion) tags['stash.os_version'] = platformVersion;
      if (Object.keys(tags).length > 0) join(tags);
    },
    () => undefined,
  );
}

/** Tags for events, attributes for spans and logs: the same facts on all three. */
function tagEverything(tags: Record<string, string>): void {
  Sentry.setTags(tags);
  Sentry.setAttributes(tags);
}

/** The record's facts as span attributes and event tags, all strings. */
function tagsOf(r: StepRecord): Record<string, string> {
  const tags: Record<string, string> = {
    'stash.journey': r.journey,
    'stash.step': r.step,
    'stash.outcome': r.outcome,
    'stash.request': r.request,
  };
  for (const [k, v] of Object.entries(r.facts)) {
    if (v !== undefined && k !== 'detail') tags[`stash.${k}`] = String(v).slice(0, TAG_MOST);
  }
  return tags;
}

/** A journey Sentry has open: its root span, and when its last step was. */
interface OpenJourney {
  root: Sentry.Span;
  last: number;
}

export function sentrySink(o: SentrySinkOptions): Sink {
  startSentry(o);
  const open = new Map<string, OpenJourney>();
  return {
    record(r) {
      abandonStale(open, r.at);
      if (r.step === 'start') open.set(r.request, openJourney(r));
      const journey = open.get(r.request);
      if (journey && r.step !== 'start') addStep(journey, r);
      addBreadcrumb(r);
      if (isTrouble(r)) reportTrouble(r);
      if (journey && (r.step === 'done' || r.outcome === 'failed')) {
        endJourney(journey, r);
        open.delete(r.request);
      }
    },
  };
}

function startSentry(o: SentrySinkOptions): void {
  Sentry.init({
    dsn: o.dsn,
    release: o.release,
    environment: o.site,
    // Our own records are the breadcrumbs, so none of the SDK's; what stays
    // is what catches an error nobody caught and what names the page.
    defaultIntegrations: false,
    integrations: [
      Sentry.eventFiltersIntegration(),
      Sentry.functionToStringIntegration(),
      Sentry.globalHandlersIntegration(),
      Sentry.linkedErrorsIntegration(),
      Sentry.dedupeIntegration(),
      Sentry.httpContextIntegration(),
      Sentry.browserSessionIntegration(),
      // The app's own warnings and errors, as logs beside the journeys.
      Sentry.consoleLoggingIntegration({ levels: ['warn', 'error'] }),
      // The last minute of the screen, kept on the phone and sent only with a
      // failure or a stall, every text, input and picture masked.
      Sentry.replayIntegration({ maskAllText: true, maskAllInputs: true, blockAllMedia: true }),
    ],
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 1,
    tracesSampleRate: 1,
    dataCollection: { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false },
    transport: Sentry.makeBrowserOfflineTransport(Sentry.makeFetchTransport),
    beforeSend: (event) => scrubValue(event),
    beforeSendSpan: (span) => scrubValue(span),
    beforeBreadcrumb: (crumb) => scrubValue(crumb),
    // A record's own console line is in Sentry already, as a span and a crumb.
    beforeSendLog: (log) => {
      const text = String(log.message);
      if (isRecordLine(text)) return null;
      return {
        ...log,
        message: scrubText(text),
        ...(log.attributes ? { attributes: scrubValue(log.attributes) } : {}),
      };
    },
  });
  tagEverything({
    'stash.device': deviceId(),
    'stash.session': session,
    'stash.host': o.hostKind,
    'stash.site': o.site,
    ...deviceTags(o.network),
  });
  askModel(tagEverything);
}

/** Ends every journey left open longer than ABANDON_MS, as abandoned. */
function abandonStale(open: Map<string, OpenJourney>, now: number): void {
  for (const [id, journey] of open) {
    if (now - journey.last < ABANDON_MS) continue;
    journey.root.setStatus({ code: 2, message: 'abandoned' });
    journey.root.end(seconds(now));
    open.delete(id);
  }
}

/** The journey as a root span, from its start record. */
function openJourney(r: StepRecord): OpenJourney {
  const root = Sentry.startInactiveSpan({
    name: r.journey,
    op: `stash.${r.journey}`,
    parentSpan: null,
    startTime: seconds(r.at),
    attributes: tagsOf(r),
  });
  return { root, last: r.at };
}

/** The step as a child span covering the wait since the step before. */
function addStep(journey: OpenJourney, r: StepRecord): void {
  Sentry.withActiveSpan(journey.root, () => {
    Sentry.startInactiveSpan({
      name: r.step,
      op: 'stash.step',
      startTime: seconds(journey.last),
      attributes: tagsOf(r),
    }).end(seconds(r.at));
  });
  journey.last = r.at;
}

const isTrouble = (r: StepRecord): boolean => r.outcome === 'failed' || r.outcome === 'stalled';

function addBreadcrumb(r: StepRecord): void {
  Sentry.addBreadcrumb({
    category: r.journey,
    message: line(r),
    level: isTrouble(r) ? 'warning' : 'info',
    timestamp: seconds(r.at),
  });
}

/** A failure or a stall as one event with the last records; an event that
 *  names the replay brings its last minute along. */
function reportTrouble(r: StepRecord): void {
  Sentry.withScope((scope) => {
    scope.setTags(tagsOf(r));
    const replayId = Sentry.getReplay()?.getReplayId();
    if (replayId) scope.setTag('replayId', replayId);
    scope.setFingerprint([r.journey, r.step, r.outcome, r.facts.kind ?? '', r.facts.reason ?? '']);
    Sentry.captureEvent({
      message: `${r.journey} ${r.outcome} at ${r.step}`,
      level: r.outcome === 'failed' ? 'error' : 'warning',
      extra: {
        ...(r.facts.detail ? { detail: r.facts.detail } : {}),
        recent: recentRecords().slice(-CONTEXT_RECORDS).map(line),
      },
    });
  });
}

function endJourney(journey: OpenJourney, r: StepRecord): void {
  journey.root.setStatus(r.outcome === 'failed' ? { code: 2, message: r.facts.kind ?? 'failed' } : { code: 1 });
  journey.root.end(seconds(r.at));
}

/** Send what is queued, now: for the page going away. */
export const flushSentry = (): Promise<boolean> => Sentry.flush(1_500);
