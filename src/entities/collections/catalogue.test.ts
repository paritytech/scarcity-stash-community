// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// Fakes the SDK read, not the chain: ours is the mapping onto the resolver's
// input (the collection-name demotion above all), the one-block page walk, and err →
// rejection. The partial mock keeps the SDK's real `artworkAddress`.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const getCollectionItems = vi.fn();
vi.mock('@parity/product-sdk-nfts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getCollectionItems: (...args: unknown[]) => getCollectionItems(...args),
}));

const { fetchCatalogue } = await import('./catalogue');
const { artworkAddress } = await import('@parity/product-sdk-nfts');

const AT = { blockHash: '0xfeed', blockNumber: 42 };
const AT2 = { blockHash: '0xbeef', blockNumber: 43 };
/** Just enough of a session for the adapter: it only forwards these on. */
const apis = {
  assetHub: {} as never,
  people: null,
  raw: { assetHub: {} as never, people: null },
};

/** A catalogue item as the SDK reports it: the typed fields lifted from the
 *  bag the way the SDK lifts them, `name` collection default included. */
const item = (index: number, attributes: Record<string, string>) => ({
  index,
  supply: 1,
  liveSupply: 1,
  transferability: 'Transferable',
  name: attributes.name ?? null,
  imageRef: attributes.image === undefined ? null : imageRefOf(attributes.image),
  rarity: attributes.rarity ?? null,
  attributes,
});

/** An `image` value read both ways: text when it is text, hex always. */
const imageRefOf = (value: string) =>
  /^0x(?:[0-9a-f]{2})*$/.test(value)
    ? { hex: value, text: null }
    : {
        hex: `0x${Array.from(new TextEncoder().encode(value), (b) => b.toString(16).padStart(2, '0')).join('')}`,
        text: value,
      };

const found = (items: unknown[], opts: { nextId?: number | null; at?: typeof AT; name?: string | null } = {}) => ({
  ok: true,
  value: {
    tag: 'Found',
    at: opts.at ?? AT,
    idCeiling: 99,
    nextId: opts.nextId ?? null,
    collection: {
      id: 7,
      name: opts.name === undefined ? 'Living World' : opts.name,
      itemCount: items.length,
      items,
    },
  },
});

beforeEach(() => getCollectionItems.mockReset());

describe('fetchCatalogue', () => {
  it('yields [] for an unknown collection (NotFound) and an empty one alike', async () => {
    getCollectionItems.mockResolvedValueOnce({
      ok: true,
      value: { tag: 'NotFound', at: AT, id: 7 },
    });
    expect(await fetchCatalogue(apis, 7)).toEqual([]);
    getCollectionItems.mockResolvedValueOnce(found([]));
    expect(await fetchCatalogue(apis, 7)).toEqual([]);
  });

  it('asks for the open attribute bag, where the keys the SDK does not type live', async () => {
    getCollectionItems.mockResolvedValueOnce(found([]));
    await fetchCatalogue(apis, 7);
    expect(getCollectionItems.mock.calls[0]?.[2]).toMatchObject({ attributes: true });
  });

  it('titles an item by its archetype, never by the collection name the bag inherits', async () => {
    getCollectionItems.mockResolvedValueOnce(
      found([
        item(0, { name: 'Living World', archetype: 'winter-hare', rarity: 'common' }),
        item(1, { name: 'Own Title', archetype: 'winter-hare', rarity: 'legendary' }),
      ]),
    );
    const [inherited, own] = await fetchCatalogue(apis, 7);
    expect(inherited).toMatchObject({
      itemIndex: 0,
      name: 'Winter Hare',
      tier: 'common',
      metadata: { name: 'Living World', archetype: 'winter-hare', rarity: 'common' },
    });
    expect(own).toMatchObject({ name: 'Own Title', tier: 'legendary' });
  });

  it('routes a bare-digest image back through its CID, as the raw bytes would', async () => {
    const digest = new Uint8Array(32).fill(7);
    const hex = `0x${Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')}`;
    getCollectionItems.mockResolvedValueOnce(found([item(0, { image: hex })]));
    const [only] = await fetchCatalogue(apis, 7);
    expect(only?.imageUrl).toContain(`/ipfs/${artworkAddress({ hex, text: null })?.cid}`);
  });

  it('walks every page against the shown block the first page pinned', async () => {
    getCollectionItems
      .mockResolvedValueOnce(found([item(0, {}), item(1, {})], { nextId: 2 }))
      .mockResolvedValueOnce(found([item(2, {})], { at: AT2 }));
    expect((await fetchCatalogue(apis, 7)).map((i) => i.itemIndex)).toEqual([0, 1, 2]);
    expect(getCollectionItems.mock.calls[0]?.[2]).toMatchObject({ at: 'best' });
    expect(getCollectionItems.mock.calls[1]?.[2]).toMatchObject({ fromId: 2, at: AT });
  });

  it('rejects when the read fails, rather than returning a Result', async () => {
    const error = new Error('Storage entry Scarcity.ItemDefs does not exist');
    getCollectionItems.mockResolvedValueOnce({ ok: false, error });
    await expect(fetchCatalogue(apis, 7)).rejects.toThrow(error);
  });
});
