// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// minters.ts is an adapter over `getClaimableCollections`, so these tests fake
// the SDK read rather than the chain underneath it. What is ours to get right
// is the mapping onto `MintCollection`, walking every page, addressing one
// block across that walk, and turning the SDK's `err` channel into a rejection,
// not the storage joins the SDK already tests.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const getClaimableCollections = vi.fn();
vi.mock('@parity/product-sdk-nfts', () => ({
  getClaimableCollections: (...args: unknown[]) => getClaimableCollections(...args),
  MAX_PAGE_LIMIT: 1000,
}));

const { fetchMintCollections } = await import('./minters');

const AT = { blockHash: '0xfeed', blockNumber: 42 };
const AT2 = { blockHash: '0xbeef', blockNumber: 43 };
/** Just enough of a session for the adapter: it only forwards these on. */
const apis = {
  assetHub: {} as never,
  people: null,
  raw: { assetHub: {} as never, people: null },
};

const ok = (collections: unknown[], nextId: number | null = null, at: typeof AT = AT) => ({
  ok: true,
  value: { at, collections, idCeiling: 99, nextId },
});

const collection = (
  id: number,
  extra: {
    name?: string | null;
    itemCount?: number | null;
  } = {},
) => ({
  id,
  name: extra.name ?? null,
  itemCount: extra.itemCount ?? null,
  owner: '5Grw',
  selection: { tag: 'Random' },
});

beforeEach(() => getClaimableCollections.mockReset());

describe('fetchMintCollections', () => {
  it('returns [] when nothing is registered', async () => {
    getClaimableCollections.mockResolvedValueOnce(ok([]));
    expect(await fetchMintCollections(apis)).toEqual([]);
  });

  it('drops an unset name (nameless → no name)', async () => {
    getClaimableCollections.mockResolvedValueOnce(
      ok([
        collection(0, { name: 'Genesis' }),
        collection(1), // no metadata → the UI shows its id
        collection(2, { name: 'Relics', itemCount: 7 }),
      ]),
    );

    expect(await fetchMintCollections(apis)).toEqual([
      { id: 0, name: 'Genesis' },
      { id: 1 },
      { id: 2, name: 'Relics', itemCount: 7 },
    ]);
  });

  it('walks every page, so a registry past one page is not truncated', async () => {
    getClaimableCollections
      .mockResolvedValueOnce(ok([collection(0), collection(1)], 2))
      .mockResolvedValueOnce(ok([collection(2)], 3, AT2))
      .mockResolvedValueOnce(ok([collection(3)], null, AT2));

    expect((await fetchMintCollections(apis)).map((c) => c.id)).toEqual([0, 1, 2, 3]);
    expect(getClaimableCollections).toHaveBeenCalledTimes(3);
    // The cursor of each page is the `fromId` of the next.
    expect(getClaimableCollections.mock.calls[1]?.[1]).toMatchObject({ fromId: 2 });
    expect(getClaimableCollections.mock.calls[2]?.[1]).toMatchObject({ fromId: 3 });
  });

  it('addresses one block across the walk: every page reads the shown block the first page pinned', async () => {
    getClaimableCollections
      .mockResolvedValueOnce(ok([collection(0)], 1))
      // A page that pinned its own block would report AT2; the adapter must
      // have asked for the block it pinned, so a mid-walk registration cannot
      // change the result.
      .mockResolvedValueOnce(ok([collection(1)], null, AT2));

    await fetchMintCollections(apis);
    expect(getClaimableCollections.mock.calls[0]?.[1]).toMatchObject({ at: 'best' });
    expect(getClaimableCollections.mock.calls[1]?.[1]).toMatchObject({ at: AT, fromId: 1 });
  });

  it('rejects when the read fails, rather than surfacing a Result to the UI', async () => {
    const error = new Error('Storage entry NftClaims.CollectionMinters does not exist');
    getClaimableCollections.mockResolvedValueOnce({ ok: false, error });
    await expect(fetchMintCollections(apis)).rejects.toThrow(error);
  });

  it('omits itemCount when the collection record is missing, rather than sending 0', async () => {
    getClaimableCollections.mockResolvedValueOnce(
      ok([collection(0, { itemCount: null }), collection(1, { itemCount: 0 })]),
    );
    const [missing, empty] = await fetchMintCollections(apis);
    expect(missing).not.toHaveProperty('itemCount');
    expect(empty).toHaveProperty('itemCount', 0);
  });
});
