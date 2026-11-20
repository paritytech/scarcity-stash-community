// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// The entry point every flow calls. A journey is opened by name; each step
// stamps a record and queues it, and the sinks drain the queue in idle time, so
// no sink sits between two steps of a mint. An overdue step records a stall,
// and a hidden page records that too.

import { deviceStore } from '@/shared/lib/deviceStore';

import { consoleSink } from './consoleSink';
import type { Facts, Journey, Outcome, Sink, StepRecord } from './record';

/** Records held before the oldest are dropped; a gap record counts how many went. */
const MOST = 1_000;
/** Records kept for a failure's context. */
const KEEP = 300;
/** Per drain: records are delivered until this much time is spent, then the rest wait for the next slot. */
const SLICE_MS = 4;
/** An idle slot is waited for at most this long. */
const IDLE_TIMEOUT_MS = 250;
/** How long a step may stand without a successor before a stall is recorded,
 *  unless the step names its own budget. */
const DEFAULT_BUDGET_MS = 30_000;

const randomId = (bytes: number): string => {
  const out = new Uint8Array(bytes);
  crypto.getRandomValues(out);
  return [...out].map((b) => b.toString(16).padStart(2, '0')).join('');
};

/** This install's id: random, made the first time it is read and saved in host storage. */
export function deviceId(): string {
  const saved = deviceStore.getState().deviceId;
  if (saved) return saved;
  const made = randomId(8);
  deviceStore.setState({ deviceId: made });
  return made;
}

/** The id of this app open. */
export const session = randomId(8);

/** The sinks every record goes to; the console one is always there. */
const sinks: Sink[] = [consoleSink];
const queue: StepRecord[] = [];
const recent: StepRecord[] = [];
let dropped = 0;
let pending = false;

/** The last records, oldest first, for a failure's context. */
export const recentRecords = (): readonly StepRecord[] => recent;

/** Add a sink; every record from now on reaches it. */
export function addSink(sink: Sink): void {
  sinks.push(sink);
}

function deliver(r: StepRecord): void {
  for (const sink of sinks) {
    try {
      sink.record(r);
    } catch (err) {
      console.warn('[telemetry] a sink failed', err);
    }
  }
}

function gapRecord(sample: StepRecord, count: number): StepRecord {
  return {
    ...sample,
    at: Date.now(),
    step: 'records dropped',
    outcome: 'failed',
    sinceStart: 0,
    sincePrev: 0,
    facts: { count },
  };
}

function drain(): void {
  const until = performance.now() + SLICE_MS;
  while (queue.length > 0 && performance.now() < until) deliver(queue.shift()!);
  if (dropped > 0 && queue.length === 0) {
    const sample = recent[recent.length - 1];
    if (sample) deliver(gapRecord(sample, dropped));
    dropped = 0;
  }
  pending = queue.length > 0;
  if (pending) schedule(drain);
}

function schedule(fn: () => void): void {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(fn, { timeout: IDLE_TIMEOUT_MS });
  else setTimeout(fn, 0);
}

function push(r: StepRecord): void {
  recent.push(r);
  if (recent.length > KEEP) recent.shift();
  if (queue.length >= MOST) {
    queue.shift();
    dropped++;
  }
  queue.push(r);
  if (!pending) {
    pending = true;
    schedule(drain);
  }
}

/** Deliver everything queued, now, on this frame: for the page going away. */
export function flushTelemetry(): void {
  while (queue.length > 0) deliver(queue.shift()!);
  if (dropped > 0) {
    const sample = recent[recent.length - 1];
    if (sample) deliver(gapRecord(sample, dropped));
    dropped = 0;
  }
  pending = false;
}

export interface JourneyHandle {
  /** The request id the records carry. */
  readonly id: string;
  /** A step reached. `budgetMs` is how long its successor may take. */
  step(name: string, facts?: Facts, budgetMs?: number): void;
  /** The journey ended well. */
  done(facts?: Facts): void;
  /** The journey ended badly: the classified kind and the chain's reason. */
  fail(kind: Facts['kind'], reason: string, facts?: Facts): void;
}

interface Open {
  handle: JourneyHandle;
  lastStep: string;
  lastAt: number;
  budget: number;
  timer: ReturnType<typeof setTimeout> | null;
  emit: (step: string, outcome: Outcome, facts?: Facts) => void;
}

const open = new Map<string, Open>();

function arm(o: Open): void {
  if (o.timer) clearTimeout(o.timer);
  o.timer = setTimeout(() => {
    o.timer = null;
    o.emit(o.lastStep, 'stalled', { ms: Date.now() - o.lastAt });
  }, o.budget);
}

function disarm(o: Open): void {
  if (o.timer) clearTimeout(o.timer);
  o.timer = null;
}

/** Open a journey. `facts` travel on every record of it. `budgetMs` is how long its first step may take. */
export function journey(
  kind: Journey,
  facts: Facts = {},
  request = `req-${randomId(8)}`,
  budgetMs = DEFAULT_BUDGET_MS,
): JourneyHandle {
  const start = Date.now();
  let prev = start;
  const emit = (step: string, outcome: Outcome, more: Facts = {}): void => {
    const at = Date.now();
    push({
      at,
      session,
      request,
      journey: kind,
      step,
      outcome,
      sinceStart: at - start,
      sincePrev: at - prev,
      facts: { ...facts, ...more },
    });
    prev = at;
  };
  const close = (): void => {
    const o = open.get(request);
    if (o) disarm(o);
    open.delete(request);
  };
  const handle: JourneyHandle = {
    id: request,
    step: (name, more, budgetMs = DEFAULT_BUDGET_MS) => {
      emit(name, 'ok', more);
      const o = open.get(request);
      if (!o) return;
      o.lastStep = name;
      o.lastAt = Date.now();
      o.budget = budgetMs;
      arm(o);
    },
    done: (more) => {
      close();
      emit('done', 'ok', more);
    },
    fail: (failKind, reason, more) => {
      close();
      emit('failed', 'failed', { ...(failKind ? { kind: failKind } : {}), reason, ...more });
    },
  };
  const o: Open = { handle, lastStep: 'start', lastAt: start, budget: budgetMs, timer: null, emit };
  open.set(request, o);
  emit('start', 'ok');
  arm(o);
  return handle;
}

/** The page went hidden or came back: every open journey records it, and its
 *  stall clock stops or starts again, so a phone in a pocket is never a stall. */
export function pageVisibility(hidden: boolean): void {
  for (const o of open.values()) {
    if (hidden) {
      o.emit(o.lastStep, 'hidden');
      disarm(o);
    } else {
      o.lastAt = Date.now();
      arm(o);
    }
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => pageVisibility(document.visibilityState === 'hidden'));
}
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushTelemetry);
}
