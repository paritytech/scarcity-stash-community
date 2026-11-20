// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MintCollectionVM } from '@/entities/collections/registry';

type Answer = { value: string | undefined } | { error: unknown } | 'hang';

interface Hoisted {
  inContainer: boolean;
  /** What a storage read of each of Jollity's names returns. */
  jollity: Record<string, Answer>;
  reads: { product?: string; key: string }[];
  offered: MintCollectionVM[];
  favourites: string[];
}
const h = vi.hoisted((): Hoisted => ({
  inContainer: true,
  jollity: {},
  reads: [],
  offered: [],
  favourites: [],
}));
vi.mock('@parity/product-sdk-host', () => ({
  getTruApi: async () => ({
    localStorage: {
      read: (request: { product?: string; key: string }) => {
        h.reads.push(request);
        const answer = h.jollity[request.product ?? ''] ?? { value: undefined };
        return {
          match: <A, B>(ok: (r: { value?: string }) => A, err: (e: unknown) => B): Promise<A | B> =>
            answer === 'hang'
              ? new Promise(() => {})
              : Promise.resolve('error' in answer ? err(answer.error) : ok({ value: answer.value })),
        };
      },
    },
  }),
  // the real one brands the string without changing it
  asProductId: (value: string) => value,
  fromHex: (hex: string) => Uint8Array.from(Buffer.from(hex.replace(/^0x/, ''), 'hex')),
  // the real one unwraps a Domain error down to the variant's tag
  formatHostError: (error: { tag?: string; value?: { value?: { tag?: string } } }) =>
    error.tag === 'Domain' ? (error.value?.value?.tag ?? 'Domain') : JSON.stringify(error),
}));
vi.mock('@/shared/host/embed', () => ({
  get isInContainer() {
    return h.inContainer;
  },
}));
vi.mock('@/shared/chain/product', () => ({ DOTNS_IDENTIFIER: 'stash.paseo', DOTNS_TLDS: ['dot', 'paseo', 'testnet'] }));
vi.mock('@/entities/collections/registry', () => ({
  getOfferedCollections: () => h.offered,
  favouriteCollections: () => h.favourites,
}));
// The approved list, as the app's constant would name these test collections.
vi.mock('@/entities/collections/approvedCollections', () => ({ OFFERED_COLLECTIONS: new Set([0, 1, 3]) }));

import { fetchSelections, jollityProductIds, parseSelections, selectCollections } from './selections';

const HARE = '1'.padStart(64, '0');
const PIZZA = '2'.padStart(64, '0');
const jollityStores = (value: unknown): Answer => ({
  value: `0x${Buffer.from(JSON.stringify(value)).toString('hex')}`,
});
const refused: Answer = { error: { tag: 'Domain', value: { tag: 'V2', value: { tag: 'AccessNotGranted' } } } };

const collection = (chainId: number, label: string): MintCollectionVM => ({
  id: String(chainId),
  chainId,
  label,
  offered: true,
});
const LIVING_WORLD = collection(0, 'Living World');
const HEARTH = collection(1, 'Hearth');
const STAGE = collection(2, 'Stage and Play');
const ANTIQUITY = collection(3, 'Antiquity');

beforeEach(() => {
  h.inContainer = true;
  h.jollity = {};
  h.reads = [];
  h.offered = [LIVING_WORLD, HEARTH, ANTIQUITY];
  h.favourites = [];
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('jollityProductIds', () => {
  it('gives the release and staging names under our network TLD', () => {
    expect(jollityProductIds('stash.paseo')).toEqual(['dim2.paseo', 'dim2next.paseo']);
    expect(jollityProductIds('other.testnet')).toEqual(['dim2.testnet', 'dim2next.testnet']);
  });

  it('gives the paseo names when our id carries no network TLD', () => {
    expect(jollityProductIds('localhost:5173')).toEqual(['dim2.paseo', 'dim2next.paseo']);
  });
});

describe('parseSelections', () => {
  it('keys each selection by the normalized credit hash, with its time when it has one', () => {
    const selections = parseSelections({
      [`0x${HARE.toUpperCase()}`]: { collectionId: 3, selectedAt: 1_795_000_000_000 },
      [`0x${PIZZA}`]: { collectionId: 0 },
    });
    expect([...selections]).toEqual([
      [HARE, { collectionId: 3, selectedAt: 1_795_000_000_000 }],
      [PIZZA, { collectionId: 0 }],
    ]);
  });

  it('drops every malformed entry, and leaves a malformed time off', () => {
    const selections = parseSelections({
      '0x1234': { collectionId: 1 },
      [`0x${HARE}`]: { collectionId: 1.5 },
      [`0x${PIZZA}`]: { collectionId: -1 },
      [`0x${'3'.padStart(64, '0')}`]: { collectionId: '2' },
      [`0x${'4'.padStart(64, '0')}`]: null,
      [`0x${'5'.padStart(64, '0')}`]: { collectionId: 7, selectedAt: 'yesterday' },
    });
    expect([...selections]).toEqual([['5'.padStart(64, '0'), { collectionId: 7 }]]);
  });

  it('reads nothing from a value that is not an object of selections', () => {
    for (const value of [null, 7, 'x', [], [{ collectionId: 1 }]]) expect(parseSelections(value).size).toBe(0);
  });
});

describe('fetchSelections', () => {
  it("reads Jollity's key under both names, the release name standing over staging", async () => {
    h.jollity = {
      'dim2.paseo': jollityStores({ [`0x${HARE}`]: { collectionId: 1 } }),
      'dim2next.paseo': jollityStores({ [`0x${HARE}`]: { collectionId: 2 }, [`0x${PIZZA}`]: { collectionId: 3 } }),
    };
    const selections = await fetchSelections();
    expect(h.reads).toEqual([
      { product: 'dim2.paseo', key: 'jollity.chest' },
      { product: 'dim2next.paseo', key: 'jollity.chest' },
    ]);
    expect(selections && [...selections]).toEqual([
      [HARE, { collectionId: 1, selectedBy: 'dim2.paseo' }],
      [PIZZA, { collectionId: 3, selectedBy: 'dim2next.paseo' }],
    ]);
    expect(console.info).toHaveBeenCalledWith('[selections] dim2.paseo 1 selections, dim2next.paseo 2 selections');
  });

  it('takes the newest selection of a credit, whichever name stores it', async () => {
    h.jollity = {
      'dim2.paseo': jollityStores({
        [`0x${HARE}`]: { collectionId: 1, selectedAt: 300 },
        [`0x${PIZZA}`]: { collectionId: 1, selectedAt: 300 },
      }),
      'dim2next.paseo': jollityStores({
        [`0x${HARE}`]: { collectionId: 0, selectedAt: 200 },
        [`0x${PIZZA}`]: { collectionId: 0, selectedAt: 400 },
      }),
    };
    const selections = await fetchSelections();
    expect(selections?.get(HARE)).toEqual({ collectionId: 1, selectedAt: 300, selectedBy: 'dim2.paseo' });
    expect(selections?.get(PIZZA)).toEqual({ collectionId: 0, selectedAt: 400, selectedBy: 'dim2next.paseo' });
  });

  it('counts a selection without a time as the oldest', async () => {
    h.jollity = {
      'dim2.paseo': jollityStores({ [`0x${HARE}`]: { collectionId: 1 } }),
      'dim2next.paseo': jollityStores({ [`0x${HARE}`]: { collectionId: 0, selectedAt: 1 } }),
    };
    expect((await fetchSelections())?.get(HARE)?.selectedBy).toBe('dim2next.paseo');
  });

  it('counts a name that grants no access as read', async () => {
    h.jollity = { 'dim2.paseo': refused, 'dim2next.paseo': jollityStores({ [`0x${PIZZA}`]: { collectionId: 3 } }) };
    const selections = await fetchSelections();
    expect(selections && [...selections.keys()]).toEqual([PIZZA]);
    expect(console.info).toHaveBeenCalledWith('[selections] dim2.paseo not granted, dim2next.paseo 1 selections');
  });

  it('returns null when a stored value is not JSON, so nothing is decided on a guess', async () => {
    h.jollity = {
      'dim2.paseo': { value: `0x${Buffer.from('not json').toString('hex')}` },
      'dim2next.paseo': jollityStores({ [`0x${HARE}`]: { collectionId: 3 } }),
    };
    expect(await fetchSelections()).toBeNull();
  });

  it('gives up on a name whose read never returns, and returns null', async () => {
    vi.useFakeTimers();
    h.jollity = { 'dim2.paseo': 'hang', 'dim2next.paseo': refused };
    const pending = fetchSelections();
    await vi.advanceTimersByTimeAsync(8_000);
    expect(await pending).toBeNull();
  });

  it('reads nothing outside a host', async () => {
    h.inContainer = false;
    expect(await fetchSelections()).toBeNull();
    expect(h.reads).toHaveLength(0);
  });
});

describe('selectCollections', () => {
  const credits = [{ hash: HARE }];

  it('sends a credit to its stored selection, with the product and the time', () => {
    const stored = new Map([[HARE, { collectionId: 3, selectedBy: 'dim2.paseo', selectedAt: 300 }]]);
    expect(selectCollections(credits, stored)?.get(HARE)).toEqual({
      selectedCollectionId: '3',
      selectedBy: 'dim2.paseo',
      selectedAt: 300,
    });
  });

  it('sends a credit with no stored selection to a default, with no product and no time', () => {
    const selected = selectCollections(credits, new Map())?.get(HARE);
    expect(selected?.selectedCollectionId).toBeDefined();
    expect(selected?.selectedBy).toBeUndefined();
    expect(selected?.selectedAt).toBeUndefined();
  });

  it('passes over a selection on a collection that is not offered, for the top favourite', () => {
    h.offered = [LIVING_WORLD, HEARTH, ANTIQUITY];
    h.favourites = ['1'];
    const stored = new Map([[HARE, { collectionId: 2, selectedBy: 'dim2.paseo', selectedAt: 300 }]]);
    expect(selectCollections(credits, stored)?.get(HARE)).toEqual({ selectedCollectionId: '1' });
  });

  it('works out the same default for every credit when a favourite is offered beside the approved ones', () => {
    const many = Array.from({ length: 24 }, (_, i) => ({ hash: i.toString(16).padStart(2, '0').padEnd(64, '0') }));
    const before = [...(selectCollections(many, new Map())?.values() ?? [])].map((s) => s.selectedCollectionId);
    h.offered = [LIVING_WORLD, STAGE, HEARTH, ANTIQUITY];
    const after = [...(selectCollections(many, new Map())?.values() ?? [])].map((s) => s.selectedCollectionId);
    expect(after).toEqual(before);
    expect(new Set(before).size).toBeGreaterThan(1);
  });

  it('decides nothing while no collection is offered', () => {
    h.offered = [];
    expect(selectCollections(credits, new Map())).toBeNull();
  });
});
