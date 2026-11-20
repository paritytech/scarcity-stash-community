// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// The grid's reads, measured from the query cache, which reports every run of
// a query: its start, each failed try, its end. The first reads of an app open
// are the steps of one `read` journey; a later run logs a line only when its
// result changes or it starts or stops failing.

import type { QueryCache } from '@tanstack/query-core';

import { journey, type JourneyHandle } from '@/shared/telemetry/log';

import type { StashPurseStatus } from './stashPurse';

/** The name a query gives itself in `meta.read` to be measured here. */
type ReadName = 'purse' | 'accounts' | 'nfts';

declare module '@tanstack/query-core' {
  interface Register {
    queryMeta: { read?: ReadName };
  }
}

const READS = {
  purse: { step: 'purse found', inWords: 'finding the stash purse' },
  accounts: { step: 'accounts listed', inWords: 'listing the accounts' },
  nfts: { step: 'NFTs read', inWords: 'the NFT read' },
} as const;

const NO_PURSE_REASON = { outsideHost: 'outside a host', hostWithoutPurses: 'the host has no purses' } as const;

/** Each first read may take this long before the journey counts as stalled. */
const READ_BUDGET_MS = 60_000;

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Measures every run of the queries in `queryCache` that have a read name. */
export function trackReads(queryCache: QueryCache): void {
  // Each new list of accounts is a new NFT query, so a start is forgotten with its query.
  const startedAt = new WeakMap<object, number>();
  const failedTries = new Map<ReadName, number>();
  const lastResult = new Map<ReadName, unknown>();
  let firstReads: JourneyHandle | undefined;

  function started(query: object): void {
    startedAt.set(query, Date.now());
    firstReads ??= journey('read', {}, undefined, READ_BUDGET_MS);
  }

  function failed(name: ReadName, error: unknown): void {
    const tries = (failedTries.get(name) ?? 0) + 1;
    failedTries.set(name, tries);
    if (tries === 1) console.warn(`[purses] ${READS[name].inWords} is failing: ${reasonOf(error)}`);
  }

  function succeeded(name: ReadName, result: unknown, ms: number): void {
    const tries = failedTries.get(name);
    if (tries) console.log(`[purses] ${READS[name].inWords} works again, failed tries: ${tries}`);
    failedTries.delete(name);

    const isFirst = !lastResult.has(name);
    const isChanged = result !== lastResult.get(name);
    lastResult.set(name, result);

    if (isFirst) firstRead(name, result, ms);
    else if (isChanged && Array.isArray(result)) {
      console.log(`[purses] ${READS[name].step}: ${result.length} in ${ms} ms`);
    }
  }

  function firstRead(name: ReadName, result: unknown, ms: number): void {
    if (name === 'purse') {
      const purse = result as StashPurseStatus;
      if (purse.status !== 'ready') {
        firstReads?.done({ reason: NO_PURSE_REASON[purse.status] });
        return;
      }
    }

    const facts = Array.isArray(result) ? { count: result.length, ms } : { ms };
    firstReads?.step(READS[name].step, facts, READ_BUDGET_MS);
    if (name === 'nfts') firstReads?.done();
  }

  queryCache.subscribe((event) => {
    if (event.type !== 'updated') return;

    const { query, action } = event;
    const name = query.meta?.read;
    // A read nobody watches any more is left out, such as the NFT read of an
    // earlier account list that finishes after the grid moved on.
    if (!name || query.getObserversCount() === 0) return;

    if (action.type === 'fetch') started(query);
    if (action.type === 'failed' || action.type === 'error') failed(name, action.error);
    // Data set by hand is no read.
    if (action.type === 'success' && !action.manual) {
      const startedAtMs = startedAt.get(query);
      if (startedAtMs !== undefined) succeeded(name, action.data, Date.now() - startedAtMs);
    }
  });
}
