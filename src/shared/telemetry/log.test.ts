// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { line } from './consoleSink';
import type * as Log from './log';
import type { StepRecord } from './record';

let addSink: typeof Log.addSink;
let deviceId: typeof Log.deviceId;
let flushTelemetry: typeof Log.flushTelemetry;
let journey: typeof Log.journey;
let pageVisibility: typeof Log.pageVisibility;
let recentRecords: typeof Log.recentRecords;
let session: typeof Log.session;

const got: StepRecord[] = [];

// A fresh module per test: no journey, record or sink carries over.
beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  ({ addSink, deviceId, flushTelemetry, journey, pageVisibility, recentRecords, session } = await import('./log'));
  got.length = 0;
  addSink({ record: (r) => got.push(r) });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the install's id", () => {
  it('is made the first time it is read, and saved with the device state', async () => {
    const { deviceStore } = await import('@/shared/lib/deviceStore');
    expect(deviceStore.getState().deviceId).toBe('');
    const id = deviceId();
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(deviceId()).toBe(id);
    expect(deviceStore.getState().deviceId).toBe(id);
  });
});

describe('a journey', () => {
  it('stamps every step with the ids and the time since the step before, and delivers off the frame', () => {
    const j = journey('mint', { credit: '0xab' });
    expect(got).toHaveLength(0);
    vi.advanceTimersByTime(1_200);
    j.step('proof fetched');
    vi.advanceTimersByTime(300);
    j.done({ instance: '7' });
    expect(got).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(got.map((r) => r.step)).toEqual(['start', 'proof fetched', 'done']);
    expect(got[0]).toMatchObject({
      journey: 'mint',
      session,
      request: j.id,
      outcome: 'ok',
      sinceStart: 0,
      facts: { credit: '0xab' },
    });
    expect(got[1]).toMatchObject({ sincePrev: 1_200, sinceStart: 1_200 });
    expect(got[2]).toMatchObject({ sincePrev: 300, sinceStart: 1_500, facts: { credit: '0xab', instance: '7' } });
  });

  it('records a stall when a step outlives its budget, once, and stops at done', () => {
    const j = journey('mint');
    j.step('submitted', {}, 5_000);
    vi.advanceTimersByTime(5_001);
    expect(got.filter((r) => r.outcome === 'stalled')).toHaveLength(1);
    expect(got.at(-1)).toMatchObject({ step: 'submitted', outcome: 'stalled', facts: { ms: 5_000 } });
    vi.advanceTimersByTime(60_000);
    expect(got.filter((r) => r.outcome === 'stalled')).toHaveLength(1);
    j.done();
    vi.advanceTimersByTime(60_000);
    expect(got.filter((r) => r.outcome === 'stalled')).toHaveLength(1);
  });

  it('gives the first step the budget the journey was opened with', () => {
    journey('read', {}, undefined, 60_000);
    vi.advanceTimersByTime(59_999);
    flushTelemetry();

    expect(got.some((r) => r.outcome === 'stalled')).toBe(false);

    vi.advanceTimersByTime(1);
    flushTelemetry();

    expect(got.at(-1)).toMatchObject({ step: 'start', outcome: 'stalled', facts: { ms: 60_000 } });
  });

  it('records the page going hidden and holds the stall clock while it is', () => {
    const j = journey('read');
    j.step('purse found', {}, 10_000);
    vi.advanceTimersByTime(4_000);
    pageVisibility(true);
    vi.advanceTimersByTime(1);
    expect(got.at(-1)).toMatchObject({ step: 'purse found', outcome: 'hidden' });
    vi.advanceTimersByTime(60_000);
    expect(got.some((r) => r.outcome === 'stalled')).toBe(false);
    pageVisibility(false);
    vi.advanceTimersByTime(10_001);
    expect(got.at(-1)).toMatchObject({ outcome: 'stalled' });
    j.fail('transient', 'gave up');
    vi.advanceTimersByTime(1);
    expect(got.at(-1)).toMatchObject({
      step: 'failed',
      outcome: 'failed',
      facts: { kind: 'transient', reason: 'gave up' },
    });
  });

  it('never lets a sink break a flow, and flushes on demand', () => {
    addSink({
      record: () => {
        throw new Error('boom');
      },
    });
    const j = journey('open');
    expect(() => j.done()).not.toThrow();
    flushTelemetry();
    expect(got.map((r) => r.step)).toEqual(['start', 'done']);
    expect(recentRecords()).toHaveLength(2);
  });

  it('drops the oldest past the cap and reports how many went', () => {
    const j = journey('open');
    for (let i = 0; i < 1_200; i++) j.step(`s${String(i)}`);
    flushTelemetry();
    const gap = got.find((r) => r.step === 'records dropped');
    expect(gap).toMatchObject({ outcome: 'failed', facts: { count: 201 } });
    expect(got.length).toBe(1_001);
  });
});

describe('the console line', () => {
  it('names the journey, the step, the wait and the facts', () => {
    const j = journey('mint', { collection: 28 });
    vi.advanceTimersByTime(1_250);
    j.step('submitted', { tx: '0x8c3e' });
    flushTelemetry();
    expect(line(got[1]!)).toBe(`[mint ${j.id.slice(-8)}] submitted +1.3s collection=28 tx=0x8c3e`);
    j.fail('fee', 'Token.FundsUnavailable');
    flushTelemetry();
    expect(line(got[2]!)).toContain('failed FAILED');
  });
});
