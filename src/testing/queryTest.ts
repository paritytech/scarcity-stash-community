// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// What a test of the queries needs: a query client of its own with fake
// timers, and results that come late or never.

import { environmentManager, QueryClient, QueryObserver, type QueryObserverOptions } from '@tanstack/query-core';
import { afterEach, beforeEach, vi } from 'vitest';

// In Node the query library takes itself to be on a server, where it does not repeat a query.
environmentManager.setIsServer(() => false);

/** Gives every test of the file fake timers and a new query client. */
export function queryClientPerTest() {
  let queryClient: QueryClient;
  let stopObserving: (() => void)[];

  beforeEach(() => {
    vi.useFakeTimers();
    queryClient = new QueryClient();
    stopObserving = [];
  });

  afterEach(() => {
    for (const stop of stopObserving) stop();
    queryClient.clear();
    vi.useRealTimers();
  });

  /** Starts the query the way the app does, by observing it. */
  function observe<Data>(options: QueryObserverOptions<Data>) {
    const observer = new QueryObserver(queryClient, options);
    stopObserving.push(observer.subscribe(() => undefined));
    return observer;
  }

  return { queryClient: () => queryClient, observe };
}

export const afterMs = (ms: number) => vi.advanceTimersByTimeAsync(ms);
export const settled = () => afterMs(0);

export const neverAnswers = () => new Promise<never>(() => undefined);
export const answersAfterMs = <Answer>(ms: number, answer: Answer) =>
  new Promise<Answer>((resolve) => globalThis.setTimeout(() => resolve(answer), ms));
