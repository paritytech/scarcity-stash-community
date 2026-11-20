// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ResolvedCollectible } from '@/entities/art/resolver';
import type * as Collectibles from '@/entities/nfts/collectibles';

import type * as CollectionItems from './collectionItems';
import type { MintPreview, PreviewPair } from './preview';

const h = vi.hoisted(() => ({
  calls: [] as PreviewPair[][],
  preview: (_pairs: PreviewPair[]): MintPreview[] => [],
}));
vi.mock('./preview', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadMintPreviewsMany: async (pairs: PreviewPair[]) => {
    h.calls.push(pairs);
    return h.preview(pairs);
  },
}));
vi.mock('@/shared/host/embed', () => ({ isInContainer: false }));

import { buildEntry } from '@/entities/nfts/format';

let collectiblesStore: typeof Collectibles.collectiblesStore;
let SESSION_STARTED_AT: number;
let fetchCollectionItems: typeof CollectionItems.fetchCollectionItems;
let listPairsToPreview: typeof CollectionItems.listPairsToPreview;

const credit = (n: number) =>
  buildEntry({ hash: n.toString(16).padStart(64, '0'), pending: true, claimable: true, awardBlock: 100 + n });

/** Each credit would mint item 3 in collection 27 and item 8 in any other, with its picture. */
const mints = (pairs: PreviewPair[]): MintPreview[] =>
  pairs.map(({ collection }) => ({
    outcome: {
      kind: 'mints',
      item: collection === 27 ? 3 : 8,
      name: `Piece of ${collection}`,
      imageUrl: 'https://gw.example/ipfs/bafypicture',
    },
  }));
const mintsWithoutPicture = (pairs: PreviewPair[]): MintPreview[] =>
  pairs.map(() => ({ outcome: { kind: 'mints', item: 3, name: 'Piece', artPending: true } }));
const fails = (pairs: PreviewPair[]): MintPreview[] => pairs.map(() => ({ outcome: { kind: 'fails' } }));

/** An item as an earlier session kept it. */
const keptItem: ResolvedCollectible = {
  url: 'https://gw.example/ipfs/bafykept',
  name: 'Kept',
  collectionIndex: 4,
  isRare: false,
  glow: '1 2 3',
  hasArt: true,
};

/** Puts these credits in the store, each going to `collectionId`, as a credits read does. */
function stand(numbers: number[], collectionId: string | null = '27') {
  const entries = numbers.map(credit);
  collectiblesStore.getState().readCredits(
    '',
    entries.map((entry) => ({ hash: entry.hash, awardBlock: entry.awardBlock ?? 0, claimable: true })),
    collectionId === null
      ? null
      : new Map(entries.map((entry) => [entry.hash, { selectedCollectionId: collectionId }])),
  );
  return entries;
}

const recordOf = (entry: { hash: string }) => collectiblesStore.getState().records[`c:${entry.hash}`]!;
const pairsNow = () => listPairsToPreview(collectiblesStore.getState().records);

/** Reads every item that is to be read now, as the sync does. */
async function readItems(): Promise<void> {
  collectiblesStore.getState().readCollectionItems(await fetchCollectionItems(pairsNow()));
}

// A fresh store per test, and with it a session that starts now.
beforeEach(async () => {
  vi.resetModules();
  ({ fetchCollectionItems, listPairsToPreview } = await import('./collectionItems'));
  ({ collectiblesStore, SESSION_STARTED_AT } = await import('@/entities/nfts/collectibles'));
  h.calls = [];
  h.preview = mints;
});

describe('the credits whose item is to be read', () => {
  it('are those that go to a collection, until their item is read in this session', async () => {
    const [c] = stand([1]);
    expect(pairsNow()).toEqual([{ credit: c!.hashHex, collection: 27 }]);
    await readItems();
    expect(pairsNow()).toEqual([]);
  });

  it('leave out a credit that goes to no collection yet', () => {
    stand([1], null);
    expect(pairsNow()).toEqual([]);
  });

  it('include a credit whose item was read in an earlier session', () => {
    const [c] = stand([1]);
    collectiblesStore
      .getState()
      .readCollectionItems([
        { credit: c!.hashHex, collectionId: '27', item: keptItem, readAt: SESSION_STARTED_AT - 1 },
      ]);
    expect(pairsNow()).toEqual([{ credit: c!.hashHex, collection: 27 }]);
  });

  it('include a credit while the picture of its item is still to come', async () => {
    const [c] = stand([1]);
    h.preview = mintsWithoutPicture;
    await readItems();
    expect(recordOf(c!).collectionItems?.['27']?.item?.artPending).toBe(true);
    expect(pairsNow()).toEqual([{ credit: c!.hashHex, collection: 27 }]);
  });

  it('leave out a credit that would mint nothing in its collection', async () => {
    const [c] = stand([1]);
    h.preview = fails;
    await readItems();
    expect(recordOf(c!).collectionItems?.['27']?.item).toBeNull();
    expect(pairsNow()).toEqual([]);
  });
});

describe('a fetch of what credits would mint', () => {
  it('returns each item with its credit, its collection and the time of the read', async () => {
    const [a, b] = stand([1, 2]);
    const reads = await fetchCollectionItems([
      { credit: a!.hashHex, collection: 27 },
      { credit: b!.hashHex, collection: 28 },
    ]);
    expect(h.calls).toHaveLength(1);
    expect(reads).toMatchObject([
      { credit: a!.hashHex, collectionId: '27', item: { name: 'Piece of 27', collectionIndex: 4, hasArt: true } },
      { credit: b!.hashHex, collectionId: '28', item: { name: 'Piece of 28', collectionIndex: 9, hasArt: true } },
    ]);
    expect(reads.every((read) => read.readAt >= SESSION_STARTED_AT)).toBe(true);
  });

  it('returns no item for a credit that would mint nothing there', async () => {
    h.preview = fails;
    const [read] = await fetchCollectionItems([{ credit: credit(1).hashHex, collection: 27 }]);
    expect(read?.item).toBeNull();
  });

  it('makes no call for no credits', async () => {
    expect(await fetchCollectionItems([])).toEqual([]);
    expect(h.calls).toHaveLength(0);
  });
});
