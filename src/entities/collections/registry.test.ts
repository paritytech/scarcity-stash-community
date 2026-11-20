// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as CollectionsStore from './collectionsStore';
import type * as Registry from './registry';

const h = vi.hoisted(() => ({
  list: [] as { id: number; name?: string; itemCount?: number }[],
  /** How many reads in a row are lost before one lands. */
  failFor: 0,
  calls: 0,
}));
vi.mock('./minters', () => ({
  loadMintCollections: async () => {
    h.calls++;
    if (h.failFor > 0) {
      h.failFor--;
      throw new Error('no answer');
    }
    return h.list;
  },
}));
vi.mock('./approvedCollections', () => ({ OFFERED_COLLECTIONS: new Set([17, 18]) }));

import { type RegistryState, RETRY_DELAYS_MS, RETRY_STEADY_MS } from './registry';

let collectionsStore: typeof CollectionsStore.collectionsStore;
let favouriteCollections: typeof Registry.favouriteCollections;
let getCollection: typeof Registry.getCollection;
let getOfferedCollections: typeof Registry.getOfferedCollections;
let getRegistrySnapshot: typeof Registry.getRegistrySnapshot;
let isFirstReadRunning: typeof Registry.isFirstReadRunning;
let kickRegistry: typeof Registry.kickRegistry;
let offeredCollectionIds: typeof Registry.offeredCollectionIds;
let refreshRegistry: typeof Registry.refreshRegistry;
let startRegistry: typeof Registry.startRegistry;
let subscribeRegistryState: typeof Registry.subscribeRegistryState;

// A fresh registry per test: no loop, state or kept collections carry over.
beforeEach(async () => {
  vi.resetModules();
  ({ collectionsStore } = await import('./collectionsStore'));
  ({
    favouriteCollections,
    getCollection,
    getOfferedCollections,
    getRegistrySnapshot,
    isFirstReadRunning,
    kickRegistry,
    offeredCollectionIds,
    refreshRegistry,
    startRegistry,
    subscribeRegistryState,
  } = await import('./registry'));
});

const THREE = [
  { id: 17, name: 'Coffee and Tea', itemCount: 47 },
  { id: 18, name: 'Jobs', itemCount: 101 },
  { id: 19, name: 'Sports', itemCount: 23 },
];
/** Let the pending read settle: the mock resolves on microtasks only. */
const settle = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

describe('the registry', () => {
  it('lists every claimable collection by name, and offers only the approved ones', async () => {
    h.list = [
      { id: 0, name: 'Living World' },
      { id: 17, name: 'Coffee and Tea', itemCount: 47 },
      { id: 18, name: 'Jobs', itemCount: 101 },
    ];
    await refreshRegistry();
    expect(getRegistrySnapshot().map((c) => [c.label, c.offered])).toEqual([
      ['Living World', false],
      ['Coffee and Tea', true],
      ['Jobs', true],
    ]);
    expect(getOfferedCollections().map((c) => c.chainId)).toEqual([17, 18]);
    expect(getCollection('0').label).toBe('Living World');
    expect(getCollection('99')).toMatchObject({ label: 'Collection 99', offered: false });
  });
});

describe('reading the registry until it lands', () => {
  // The first describe read once through the plain refresh: start each of these clean.
  beforeEach(() => {
    h.failFor = 0;
    h.calls = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    h.failFor = 0;
    h.calls = 0;
  });

  it('asks at launch, then on the schedule, and keeps asking every minute', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.list = THREE;
    h.failFor = 99;
    const states: RegistryState[] = [];
    subscribeRegistryState((s) => states.push(s));
    expect(isFirstReadRunning()).toBe(true);
    startRegistry();
    expect(isFirstReadRunning()).toBe(true);
    await settle();
    expect(h.calls).toBe(1);
    expect(states.at(-1)).toMatchObject({ phase: 'reading', lost: 1 });
    expect(isFirstReadRunning()).toBe(false);
    // The schedule: 2, 5, 10, 20, 40 s after each lost read, then every 60 s.
    for (const [k, delay] of RETRY_DELAYS_MS.entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      await settle();
      expect(h.calls).toBe(k + 1);
      await vi.advanceTimersByTimeAsync(1);
      await settle();
      expect(h.calls).toBe(k + 2);
    }
    expect(states.at(-1)).toMatchObject({
      phase: 'reading',
      lost: RETRY_DELAYS_MS.length + 1,
    });
    await vi.advanceTimersByTimeAsync(RETRY_STEADY_MS);
    await settle();
    expect(h.calls).toBe(RETRY_DELAYS_MS.length + 2);
    expect(getRegistrySnapshot()).toEqual([]);
  });

  it('the first read that lands after lost ones fills the list and ends the schedule', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.list = THREE;
    const lostFirst = 4;
    h.failFor = lostFirst;
    let state: RegistryState | undefined;
    subscribeRegistryState((s) => {
      state = s;
    });
    startRegistry();
    await settle();
    for (const delay of RETRY_DELAYS_MS.slice(0, lostFirst)) {
      await vi.advanceTimersByTimeAsync(delay);
      await settle();
    }
    expect(state).toMatchObject({ phase: 'read', reads: 1, lost: 0 });
    expect(getOfferedCollections().map((c) => c.label)).toEqual(['Coffee and Tea', 'Jobs']);
    const calls = h.calls;
    await vi.advanceTimersByTimeAsync(RETRY_STEADY_MS * 3);
    await settle();
    expect(h.calls).toBe(calls);
  });

  it('a kick asks at once while no read has landed, and a read in flight is not asked twice', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.list = THREE;
    h.failFor = 1;
    startRegistry();
    await settle();
    expect(h.calls).toBe(1);
    kickRegistry();
    kickRegistry();
    await settle();
    expect(h.calls).toBe(2);
    expect(getRegistrySnapshot().length).toBe(3);
    kickRegistry();
    await settle();
    expect(h.calls).toBe(2);
  });

  it('a read lost after one landed keeps the list', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.list = THREE;
    let state: RegistryState | undefined;
    subscribeRegistryState((s) => {
      state = s;
    });
    startRegistry();
    await settle();
    expect(state?.phase).toBe('read');
    expect(isFirstReadRunning()).toBe(false);
    h.failFor = 1;
    await refreshRegistry().catch(() => {});
    expect(getRegistrySnapshot().length).toBe(3);
    expect(state?.phase).toBe('read');
  });
});

describe('the collections a credit may open in', () => {
  it('are the approved ones and the favourites, in registry order, and the grid lays them all out', async () => {
    h.list = THREE;
    await refreshRegistry();
    expect(getOfferedCollections().map((c) => c.chainId)).toEqual([17, 18]);
    collectionsStore.setState({ favourites: ['19', '40'] });
    expect(getOfferedCollections().map((c) => c.chainId)).toEqual([17, 18, 19]);
    expect(offeredCollectionIds()).toEqual(['17', '18', '19', '40']);
    expect(favouriteCollections()).toEqual(['19', '40']);
  });
});

describe('the collections the device kept', () => {
  afterEach(() => {
    vi.doUnmock('@/shared/lib/stateStorage');
  });

  it('name the collections before any read lands', async () => {
    h.calls = 0;
    const saved = new Map([
      ['pkt_collections_v1', JSON.stringify({ state: { known: THREE, favourites: [] }, version: 1 })],
    ]);
    vi.doMock('@/shared/lib/stateStorage', () => ({
      stateStorage: { getItem: (k: string) => saved.get(k) ?? null, setItem: () => {}, removeItem: () => {} },
    }));
    vi.resetModules();
    const fresh = await import('./registry');
    await (await import('./collectionsStore')).collectionsStore.persist.rehydrate();
    expect(fresh.getRegistrySnapshot().map((c) => c.label)).toEqual(['Coffee and Tea', 'Jobs', 'Sports']);
    expect(fresh.getCollection('19')).toMatchObject({ label: 'Sports', itemCount: 23, offered: false });
    expect(h.calls).toBe(0);
  });
});
