// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { failsOutcome, fakeAssetHub, metadataLayers, mintsOutcome, text } from '@/testing/fakeChain';
import { GATEWAY } from '@/testing/fakeManifest';

import type * as Preview from './preview';

const PICTURE_CID = 'bafybeigdyrztexampleabcdefghijklmno';

let previewMintsMany: typeof Preview.previewMintsMany;

// A fresh module per test, so no manifest stays cached from the test before.
beforeEach(async () => {
  vi.resetModules();
  ({ previewMintsMany } = await import('./preview'));
});

/** One credit against each of `collections`, as one batch of pairs. */
const previewMints = (api: Parameters<typeof previewMintsMany>[0], credit: string, collections: number[]) =>
  previewMintsMany(
    api,
    collections.map((collection) => ({ credit, collection })),
  );

const itemMeta = (name: string, image?: string) =>
  metadataLayers({ item: { name: text(name), ...(image ? { image: text(image) } : {}) } });

describe('previewMintsMany for one credit', () => {
  it('returns [] and makes no runtime call for no collections', async () => {
    const { api, spies } = fakeAssetHub();
    expect(await previewMints(api, '0xcafe', [])).toEqual([]);
    expect(spies.previewMints).not.toHaveBeenCalled();
  });

  it('maps mints/fails per collection and resolves Mints item metadata in one batch', async () => {
    const { api, spies } = fakeAssetHub({
      previewByCollection: new Map<number, unknown>([
        [0, mintsOutcome(5, 'random')],
        [1, failsOutcome('Soulbound')],
        [2, mintsOutcome(9, 'contract')],
      ]),
      metadataByItem: new Map<string, unknown>([
        ['0:5', itemMeta('Sword', PICTURE_CID)],
        ['2:9', itemMeta('Shield')],
      ]),
    });

    const out = await previewMints(api, 'cafe', [0, 1, 2]);
    expect(out).toMatchObject([
      {
        outcome: {
          kind: 'mints',
          item: 5,
          name: 'Sword',
          imageUrl: `${GATEWAY}/ipfs/${PICTURE_CID}`,
        },
      },
      { outcome: { kind: 'fails' } },
      { outcome: { kind: 'mints', item: 9, name: 'Shield' } },
    ]);
    // one preview_mints for all collections; one metadata_batch for the 2 Mints items
    expect(spies.previewMints).toHaveBeenCalledTimes(1);
    expect(spies.metadataBatch).toHaveBeenCalledTimes(1);
  });

  it('0x-prefixes a bare credit hash in the query', async () => {
    const { api, spies } = fakeAssetHub({
      previewByCollection: new Map<number, unknown>([[0, failsOutcome('X')]]),
    });
    await previewMints(api, 'cafe', [0]);
    expect(spies.previewMints.mock.calls[0]![0]).toEqual([{ credit: '0xcafe', collection: 0 }]);
  });

  it('skips the metadata batch when every outcome is a fail', async () => {
    const { api, spies } = fakeAssetHub({
      previewByCollection: new Map<number, unknown>([[0, failsOutcome('Soulbound')]]),
    });
    const out = await previewMints(api, '0xcafe', [0]);
    expect(out).toEqual([{ outcome: { kind: 'fails' } }]);
    expect(spies.metadataBatch).not.toHaveBeenCalled();
  });

  it('throws when the runtime rejects the whole batch', async () => {
    const { api } = fakeAssetHub({ previewRefusal: { type: 'TooLarge' } });
    await expect(previewMints(api, '0xcafe', [0, 1])).rejects.toThrow('TooLarge');
  });
});

describe('previewMintsMany', () => {
  it('asks the chain at most 32 pairs per call and keeps the results positional', async () => {
    const { api, spies } = fakeAssetHub({
      previewByCollection: new Map<number, unknown>([
        [0, failsOutcome('NoItems')],
        [1, mintsOutcome(4)],
      ]),
    });
    const pairs = Array.from({ length: 70 }, (_, i) => ({
      credit: '0x' + (i + 1).toString(16).padStart(64, '0'),
      collection: i % 2,
    }));

    const out = await previewMintsMany(api, pairs);
    expect(spies.previewMints.mock.calls.map(([queries]) => queries.length)).toEqual([32, 32, 6]);
    expect(out.map((p) => p.outcome.kind)).toEqual(pairs.map((p) => (p.collection === 0 ? 'fails' : 'mints')));
  });
});

describe('mints outcomes carry the stated tier', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  it('an item whose manifest no source served comes back waiting for its picture', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, arrayBuffer: async () => new ArrayBuffer(0) })),
    );
    const manifest = 'b' + 'q'.repeat(58);
    const { api } = fakeAssetHub({
      previewByCollection: new Map<number, unknown>([[0, mintsOutcome(5)]]),
      metadataByItem: new Map<string, unknown>([
        [
          '0:5',
          metadataLayers({
            item: {
              name: text('Caffe Latte'),
              manifest: text(manifest),
              archetype: text('caffe-latte'),
            },
          }),
        ],
      ]),
    });
    const out = await previewMints(api, '0x' + 'aa'.repeat(32), [0]);
    expect(out[0]!.outcome).toMatchObject({
      kind: 'mints',
      item: 5,
      name: 'Caffe Latte',
      artPending: true,
    });
    expect(out[0]!.outcome).not.toHaveProperty('imageUrl');
  });
  it('reads a name the SDK would not read as text as hex, the way the minted NFT will', async () => {
    const { api } = fakeAssetHub({
      previewByCollection: new Map<number, unknown>([[0, mintsOutcome(5)]]),
      metadataByItem: new Map<string, unknown>([['0:5', metadataLayers({ item: { name: text('Sw\u202eord') } })]]),
    });
    const out = await previewMints(api, '0x' + 'aa'.repeat(32), [0]);
    expect(out[0]!.outcome).toMatchObject({ kind: 'mints', name: '0x5377e280ae6f7264' });
  });

  it('reads tier from the item metadata even before any manifest is fetched', async () => {
    const { api } = fakeAssetHub({
      previewByCollection: new Map<number, unknown>([[0, mintsOutcome(5)]]),
      metadataByItem: new Map<string, unknown>([
        ['0:5', metadataLayers({ item: { name: text('Sword'), rarity: text('legendary') } })],
      ]),
    });
    const out = await previewMints(api, '0x' + 'aa'.repeat(32), [0]);
    expect(out[0]!.outcome).toMatchObject({
      kind: 'mints',
      item: 5,
      name: 'Sword',
      tier: 'legendary',
    });
  });
});
