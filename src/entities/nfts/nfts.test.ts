// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type FetchedManifest, parseManifest } from '@/entities/art/manifest';
import {
  bytesFromHex,
  type FakeAssetHubData,
  fakeAssetHubSession,
  metadataLayers,
  nft,
  text,
} from '@/testing/fakeChain';
import { cid32, GATEWAY, manifestDoc, serveManifest } from '@/testing/fakeManifest';

import type * as Nfts from './nfts';

const PICTURE_CID = 'bafybeigdyrztexampleabcdefghijklmno';

let addArt: typeof Nfts.addArt;
let fetchArt: typeof Nfts.fetchArt;
let fetchNfts: typeof Nfts.fetchNfts;
let formatNfts: typeof Nfts.formatNfts;
let manifestCidsOf: typeof Nfts.manifestCidsOf;

// A fresh module per test, so no manifest stays cached from the test before.
beforeEach(async () => {
  vi.resetModules();
  ({ addArt, fetchArt, fetchNfts, formatNfts, manifestCidsOf } = await import('./nfts'));
});

const HASH_HEX = '0x' + '11'.repeat(32);
const THUMBNAIL_URL = `${GATEWAY}/ipfs/${cid32('thumb')}`;

// One NFT read of `addresses` on a chain that holds `data`.
async function readNfts(data: FakeAssetHubData, addresses: string[]) {
  const { apis } = fakeAssetHubSession(data);
  return formatNfts(await fetchNfts(apis, addresses));
}

function manyNfts(count: number) {
  const addresses = Array.from({ length: count }, (_, i) => `account-${i}`);
  const nftsByOwner = new Map(addresses.map((address, i) => [address, nft({ instance: BigInt(i) })]));
  return { addresses, nftsByOwner };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchNfts', () => {
  it('asks who holds what for every address in one request, at the block the app shows', async () => {
    const { apis, spies } = fakeAssetHubSession({ nftsByOwner: new Map([['alice', nft({ instance: 7n })]]) });

    const raw = await fetchNfts(apis, ['alice', 'bob']);

    expect(spies.nftsByOwner).toHaveBeenCalledTimes(1);
    expect(spies.nftsByOwner).toHaveBeenCalledWith([['alice'], ['bob']], { at: '0xbe57' });
    expect(raw.nftsByOwner.map((held) => held?.instance)).toEqual([7n, undefined]);
  });

  it('asks for the displays of the held NFTs, at the same block', async () => {
    const { apis, spies } = fakeAssetHubSession({
      nftsByOwner: new Map([
        ['alice', nft({ instance: 7n })],
        ['carol', nft({ instance: 9n })],
      ]),
    });

    const raw = await fetchNfts(apis, ['alice', 'bob', 'carol']);

    expect(spies.metadataBatch).toHaveBeenCalledTimes(1);
    expect(spies.metadataBatch.mock.calls[0]![0]).toHaveLength(2);
    expect(spies.metadataBatch.mock.calls[0]![1]).toMatchObject({ at: '0xbe57' });
    expect(spies.itemDefs.mock.calls[0]![1]).toMatchObject({ at: '0xbe57' });
    expect(raw.displays.map((display) => display.tag === 'Found' && display.instance)).toEqual([7n, 9n]);
  });

  it('asks for the displays 128 NFTs at a time', async () => {
    const { addresses, nftsByOwner } = manyNfts(130);
    const { apis, spies } = fakeAssetHubSession({ nftsByOwner });

    const raw = await fetchNfts(apis, addresses);

    expect(spies.metadataBatch.mock.calls.map(([queries]) => queries.length)).toEqual([128, 2]);
    expect(raw.displays).toHaveLength(130);
  });

  it('asks for 128 displays in one call', async () => {
    const { addresses, nftsByOwner } = manyNfts(128);
    const { apis, spies } = fakeAssetHubSession({ nftsByOwner });

    await fetchNfts(apis, addresses);

    expect(spies.metadataBatch.mock.calls.map(([queries]) => queries.length)).toEqual([128]);
  });

  it('asks for no display when no address holds an NFT', async () => {
    const { apis, spies } = fakeAssetHubSession();

    const raw = await fetchNfts(apis, ['alice']);

    expect(spies.metadataBatch).not.toHaveBeenCalled();
    expect(raw.displays).toEqual([]);
  });

  it('fetches no art', async () => {
    const { cid, fetchSpy } = await serveManifest(manifestDoc('greek-coffee', 'common'));
    const { apis } = fakeAssetHubSession({
      nftsByOwner: new Map([['alice', nft({ instance: 5n })]]),
      metadataByInstance: new Map([['5', metadataLayers({ item: { manifest: text(cid) } })]]),
    });

    await fetchNfts(apis, ['alice']);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('throws when the runtime rejects the displays', async () => {
    const { apis } = fakeAssetHubSession({
      nftsByOwner: new Map([['alice', nft({ instance: 1n })]]),
      metadataRefusal: { type: 'TooLarge' },
    });

    await expect(fetchNfts(apis, ['alice'])).rejects.toThrow(/refused/);
  });
});

describe('formatNfts', () => {
  it('gives the NFT of each address that holds one, and none for an address that holds none', async () => {
    const nfts = await readNfts(
      {
        nftsByOwner: new Map([
          ['alice', nft({ instance: 7n })],
          ['carol', nft({ instance: 9n })],
        ]),
      },
      ['alice', 'bob', 'carol'],
    );

    expect(nfts.map((owned) => [owned.purse, owned.instance])).toEqual([
      ['alice', '7'],
      ['carol', '9'],
    ]);
  });

  it('takes the identity hash, the name and the picture from the metadata', async () => {
    const [owned] = await readNfts(
      {
        nftsByOwner: new Map([['alice', nft({ instance: 5n, mintedAt: 1234n, collection: 2, item: 9 })]]),
        metadataByInstance: new Map([
          [
            '5',
            metadataLayers({
              instance: { hash: bytesFromHex(HASH_HEX), name: text('Sword'), image: text(PICTURE_CID) },
            }),
          ],
        ]),
      },
      ['alice'],
    );

    expect(owned).toMatchObject({
      hash: HASH_HEX,
      mintedAt: 1234,
      name: 'Sword',
      imageUrl: `${GATEWAY}/ipfs/${PICTURE_CID}`,
      collectionId: '2',
      itemIndex: 9,
      metadata: { name: 'Sword', image: PICTURE_CID },
    });
  });

  it("names a rarity level through the collection's table", async () => {
    const [owned] = await readNfts(
      {
        nftsByOwner: new Map([['alice', nft({ instance: 5n })]]),
        metadataByInstance: new Map([
          [
            '5',
            metadataLayers({
              item: { rarity: text('200') },
              collection: { rarities: text('100=Common,200=Rare') },
            }),
          ],
        ]),
      },
      ['alice'],
    );

    expect(owned).toMatchObject({ tier: 'Rare', rare: true });
  });

  it('carries when each NFT was minted and when it reached its account', async () => {
    const nfts = await readNfts(
      {
        nftsByOwner: new Map([
          ['alice', nft({ instance: 5n, mintedAt: 1_000n, lastMoved: 9_000n })],
          ['bob', nft({ instance: 6n, mintedAt: 2_000n })],
        ]),
      },
      ['alice', 'bob'],
    );

    expect(nfts.map((owned) => [owned.mintedAt, owned.lastMoved])).toEqual([
      [1_000, 9_000],
      [2_000, 2_000],
    ]);
  });

  it('keys an NFT by the bytes of its hash metadata even when they read as text', async () => {
    // 32 ASCII bytes: the SDK reports them as text, and the identity is still their hex.
    const ascii = 'abcdefghijklmnopqrstuvwxyz012345';
    const [owned] = await readNfts(
      {
        nftsByOwner: new Map([['alice', nft({ instance: 5n })]]),
        metadataByInstance: new Map([['5', metadataLayers({ instance: { hash: text(ascii) } })]]),
      },
      ['alice'],
    );

    expect(owned?.hash).toBe(`0x${Array.from(text(ascii), (b) => b.toString(16).padStart(2, '0')).join('')}`);
  });

  it('keys an NFT without hash metadata by its instance', async () => {
    const [owned] = await readNfts({ nftsByOwner: new Map([['alice', nft({ instance: 9n })]]) }, ['alice']);

    expect(owned?.hash).toBe('instance-9');
  });

  it('gives an NFT the runtime does not resolve without a look', async () => {
    const [owned] = await readNfts(
      {
        nftsByOwner: new Map([['alice', nft({ instance: 9n, mintedAt: 5n, collection: 1, item: 2 })]]),
        metadataByInstance: new Map([['9', metadataLayers({ instance: { name: text('Gone') } })]]),
        unresolved: new Set(['9']),
      },
      ['alice'],
    );

    expect(owned).toEqual({
      hash: 'instance-9',
      mintedAt: 5,
      lastMoved: 5,
      instance: '9',
      purse: 'alice',
      collectionId: '1',
      itemIndex: 2,
    });
  });

  it('leaves the art out and keeps the manifest CID in the metadata', async () => {
    const [owned] = await readNfts(
      {
        nftsByOwner: new Map([['alice', nft({ instance: 5n })]]),
        metadataByInstance: new Map([
          ['5', metadataLayers({ item: { manifest: text(cid32('m')), archetype: text('greek-coffee') } })],
        ]),
      },
      ['alice'],
    );

    expect(owned).toMatchObject({ name: 'Greek Coffee', metadata: { manifest: cid32('m') } });
    expect(owned?.imageUrl).toBeUndefined();
    expect(owned?.artPending).toBeUndefined();
  });
});

describe('manifestCidsOf', () => {
  const nftWith = (attributes: Record<string, string>) => ({ hash: 'h', metadata: attributes });

  it('gives each manifest CID once, sorted', () => {
    const cids = manifestCidsOf([
      nftWith({ manifest: cid32('b') }),
      nftWith({ manifest: cid32('a') }),
      nftWith({ manifest: cid32('b') }),
    ]);

    expect(cids).toEqual([cid32('a'), cid32('b')].sort());
  });

  it('skips an NFT without a manifest, and a manifest that is not a CID', () => {
    expect(manifestCidsOf([{ hash: 'h' }, nftWith({ name: 'Sword' }), nftWith({ manifest: 'not a cid' })])).toEqual([]);
  });
});

describe('fetchArt', () => {
  it('fetches a manifest once, however often it is asked for', async () => {
    const { cid, fetchSpy } = await serveManifest(manifestDoc('greek-coffee', 'common'));

    const first = await fetchArt(cid);
    const second = await fetchArt(cid);

    expect(first.manifest).toMatchObject({ archetype: 'greek-coffee' });
    expect(second).toEqual(first);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('asks again for a manifest that no source served', async () => {
    const doc = manifestDoc('greek-coffee', 'common');
    const { cid } = await serveManifest(doc);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 404 })),
    );

    expect(await fetchArt(cid)).toEqual({ manifest: null, transient: true });

    await serveManifest(doc);

    expect((await fetchArt(cid)).manifest).toMatchObject({ archetype: 'greek-coffee' });
  });
});

describe('addArt', () => {
  const cid = cid32('m');
  const served = (archetype: string, rarity: string): FetchedManifest => ({
    manifest: parseManifest(manifestDoc(archetype, rarity)),
    transient: false,
  });
  const greekCoffee = { hash: 'h', name: 'Greek Coffee', metadata: { manifest: cid, archetype: 'greek-coffee' } };

  it("takes the manifest's thumbnail for the picture", () => {
    const [owned] = addArt([greekCoffee], { [cid]: served('greek-coffee', 'common') });

    expect(owned).toMatchObject({ name: 'Greek Coffee', tier: 'common', imageUrl: THUMBNAIL_URL });
    expect(owned?.artPending).toBeUndefined();
  });

  it('shows the picture as pending while the manifest has not arrived', () => {
    const [owned] = addArt([greekCoffee], {});

    expect(owned).toMatchObject({ artPending: true });
    expect(owned?.imageUrl).toBeUndefined();
  });

  it('shows the picture as pending when no source served the manifest', () => {
    const [owned] = addArt([greekCoffee], { [cid]: { manifest: null, transient: true } });

    expect(owned).toMatchObject({ artPending: true });
  });

  it('leaves the NFT as it is when its manifest was rejected', () => {
    expect(addArt([greekCoffee], { [cid]: { manifest: null, transient: false } })).toEqual([greekCoffee]);
  });

  it('ignores a manifest that contradicts the chain', () => {
    expect(addArt([greekCoffee], { [cid]: served('hare', 'common') })).toEqual([greekCoffee]);
  });

  it('leaves an NFT without a manifest as it is', () => {
    const sword = { hash: 'h', name: 'Sword', metadata: { name: 'Sword' } };

    expect(addArt([sword], {})).toEqual([sword]);
  });

  it('gives an NFT read from the chain the name, tier and picture of its manifest', async () => {
    const { cid: served } = await serveManifest(manifestDoc('greek-coffee', 'common'));
    const nfts = await readNfts(
      {
        nftsByOwner: new Map([['alice', nft({ instance: 5n })]]),
        metadataByInstance: new Map([
          [
            '5',
            metadataLayers({
              item: { manifest: text(served), archetype: text('greek-coffee'), rarity: text('common') },
            }),
          ],
        ]),
      },
      ['alice'],
    );

    const [cid] = manifestCidsOf(nfts);
    const [owned] = addArt(nfts, { [cid!]: await fetchArt(cid!) });

    expect(owned).toMatchObject({ name: 'Greek Coffee', tier: 'common', imageUrl: THUMBNAIL_URL });
  });
});
