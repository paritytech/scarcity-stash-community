// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// The collections saved for the next open: read back by rehydrate; written only
// when a read brings something new; a malformed entry or a store saved in
// another shape dropped, never trusted.

import { beforeEach, describe, expect, it } from 'vitest';
import type { StateStorage } from 'zustand/middleware';

import { createCollectionsStore } from './collectionsStore';

const SPORTS = { id: 26, name: 'Sports', itemCount: 18 };
const COFFEE = { id: 27, name: 'Coffee and Tea', itemCount: 19 };

/** A storage with the writes it took. */
const saved = new Map<string, string>();
const writes: string[] = [];
const storage: StateStorage = {
  getItem: (k) => saved.get(k) ?? null,
  setItem: (k, v) => {
    saved.set(k, v);
    writes.push(k);
  },
  removeItem: (k) => {
    saved.delete(k);
  },
};
const kept = (state: unknown, version = 1): string => JSON.stringify({ state, version });

/** A fresh page: a store made anew, with what is saved read back. */
async function open() {
  const store = createCollectionsStore(storage);
  await store.persist.rehydrate();
  return store;
}

beforeEach(() => {
  saved.clear();
  writes.length = 0;
});

describe('the collections saved for the next open', () => {
  it('reads the last list and the favourites back with rehydrate', async () => {
    saved.set('pkt_collections_v1', kept({ known: [SPORTS, COFFEE], favourites: ['27'] }));
    expect(createCollectionsStore(storage).getState().known).toEqual([]);
    const store = await open();
    expect(store.getState().known).toEqual([SPORTS, COFFEE]);
    expect(store.getState().favourites).toEqual(['27']);
  });

  it('writes a read only when it brings something new', async () => {
    const store = await open();
    store.getState().read([SPORTS, COFFEE]);
    store.getState().read([{ ...SPORTS }, { ...COFFEE }]);
    expect(writes).toEqual(['pkt_collections_v1']);
    store.getState().read([{ ...SPORTS, itemCount: 20 }, COFFEE]);
    expect(writes).toHaveLength(2);
    expect(store.getState().known[0]?.itemCount).toBe(20);
  });

  it('drops malformed entries one by one, and a store kept in another version whole', async () => {
    saved.set(
      'pkt_collections_v1',
      kept({
        known: [SPORTS, { id: -1 }, { id: 26 }, { id: 7, name: 3, itemCount: 1.5 }],
        favourites: ['27', 27, 'x', '27'],
      }),
    );
    const store = await open();
    expect(store.getState().known).toEqual([SPORTS, { id: 7 }]);
    expect(store.getState().favourites).toEqual(['27']);

    saved.set('pkt_collections_v1', kept({ known: [SPORTS], favourites: [] }, 0));
    expect((await open()).getState().known).toEqual([]);
  });
});
