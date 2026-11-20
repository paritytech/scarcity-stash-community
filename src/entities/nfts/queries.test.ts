// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

import type * as ProductSdkHost from '@parity/product-sdk-host';
import type { NftPurseItemKey } from '@parity/product-sdk-host';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as Manifest from '@/entities/art/manifest';
import { type FetchedManifest, parseManifest } from '@/entities/art/manifest';
import type { ChainApis } from '@/shared/chain/client';
import { addressOfPublicKey } from '@/shared/chain/ss58';
import { fakeAssetHubSession, metadataLayers, nft, text } from '@/testing/fakeChain';
import { hostError, publicKey } from '@/testing/fakeHost';
import { cid32, manifestDoc } from '@/testing/fakeManifest';
import { afterMs, answersAfterMs, neverAnswers, queryClientPerTest, settled } from '@/testing/queryTest';

import { accountPublicKeysQuery, artQuery, nftsQuery, stashPurseQuery } from './queries';

const host = vi.hoisted(() => ({
  manager: null as null | Record<string, ReturnType<typeof vi.fn>>,
}));

const chain = vi.hoisted(() => ({
  apis: null as null | ChainApis,
  getChainApis: vi.fn(),
}));

vi.mock('@parity/product-sdk-host', async (importOriginal) => ({
  ...(await importOriginal<typeof ProductSdkHost>()),
  getNftPurseManager: async () => host.manager,
}));

const art = vi.hoisted(() => ({
  readManifest: vi.fn(),
}));

vi.mock('@/shared/chain/client', () => ({
  getChainApis: chain.getChainApis,
}));

vi.mock('@/entities/art/manifest', async (importOriginal) => ({
  ...(await importOriginal<typeof Manifest>()),
  readManifest: art.readManifest,
}));

const { observe } = queryClientPerTest();

beforeEach(() => {
  host.manager = null;
  chain.apis = null;
  chain.getChainApis.mockImplementation(async () => chain.apis);
  art.readManifest.mockReset();
});

const [alice, bob] = [publicKey(1), publicKey(2)];

describe('stashPurseQuery', () => {
  function hostWithStashPurse(id: number) {
    const listPurses = vi.fn(async () => [{ id, name: 'stash' }]);
    host.manager = { listPurses };
    return listPurses;
  }

  it('finds the stash purse', async () => {
    hostWithStashPurse(4);

    const purse = observe(stashPurseQuery);
    await settled();

    expect(purse.getCurrentResult().data).toEqual({ status: 'ready', id: 4 });
  });

  it('asks the host once, however often the purse is needed', async () => {
    const listPurses = hostWithStashPurse(4);

    observe(stashPurseQuery);
    await afterMs(60_000);
    const later = observe(stashPurseQuery);
    await settled();

    expect(later.getCurrentResult().data).toEqual({ status: 'ready', id: 4 });
    expect(listPurses).toHaveBeenCalledTimes(1);
  });

  it('tries a failed lookup again until it succeeds, after 1, 2, 4, 8 and 16 seconds', async () => {
    const listPurses = hostWithStashPurse(4);
    for (let failed = 0; failed < 5; failed++) listPurses.mockRejectedValueOnce(hostError('Denied'));

    const purse = observe(stashPurseQuery);
    await afterMs(1_000 + 2_000 + 4_000 + 8_000 + 16_000 - 1);

    expect(listPurses).toHaveBeenCalledTimes(5);
    expect(purse.getCurrentResult().data).toBeUndefined();

    await afterMs(1);

    expect(listPurses).toHaveBeenCalledTimes(6);
    expect(purse.getCurrentResult().data).toEqual({ status: 'ready', id: 4 });
  });

  it('does not ask a host without purses again', async () => {
    const listPurses = vi.fn().mockRejectedValue(hostError('Unsupported'));
    host.manager = { listPurses };

    const purse = observe(stashPurseQuery);
    await afterMs(60_000);

    expect(purse.getCurrentResult().data).toEqual({ status: 'hostWithoutPurses' });
    expect(listPurses).toHaveBeenCalledTimes(1);
  });
});

describe('accountPublicKeysQuery', () => {
  const onePage = (items: NftPurseItemKey[]) => ({ items, hasNext: false });

  function hostWithAccounts() {
    const queryPurse = vi.fn();
    host.manager = { queryPurse };
    return queryPurse;
  }

  it('lists the public keys of the accounts of the purse', async () => {
    const queryPurse = hostWithAccounts().mockResolvedValue(onePage([alice, bob]));

    const accounts = observe(accountPublicKeysQuery(4));
    await settled();

    expect(accounts.getCurrentResult().data).toEqual([alice, bob]);
    expect(queryPurse).toHaveBeenCalledWith({ purse: 4, page: 0, pageSize: 100 });
  });

  it('lists the accounts of each purse separately', async () => {
    const queryPurse = hostWithAccounts().mockResolvedValue(onePage([alice]));

    observe(accountPublicKeysQuery(4));
    observe(accountPublicKeysQuery(5));
    await settled();

    expect(queryPurse).toHaveBeenCalledWith({ purse: 4, page: 0, pageSize: 100 });
    expect(queryPurse).toHaveBeenCalledWith({ purse: 5, page: 0, pageSize: 100 });
  });

  it('lists them again 5 seconds after the last list arrived', async () => {
    const queryPurse = hostWithAccounts()
      .mockImplementationOnce(() => answersAfterMs(2_000, onePage([alice])))
      .mockResolvedValue(onePage([alice, bob]));

    const accounts = observe(accountPublicKeysQuery(4));
    await afterMs(2_000 + 5_000 - 1);

    expect(queryPurse).toHaveBeenCalledTimes(1);
    expect(accounts.getCurrentResult().data).toEqual([alice]);

    await afterMs(1);

    expect(queryPurse).toHaveBeenCalledTimes(2);
    expect(accounts.getCurrentResult().data).toEqual([alice, bob]);

    await afterMs(5_000);

    expect(queryPurse).toHaveBeenCalledTimes(3);
  });

  it('keeps the last list when the host fails, and asks again 5 seconds later', async () => {
    const queryPurse = hostWithAccounts()
      .mockResolvedValueOnce(onePage([alice]))
      .mockRejectedValueOnce(hostError('Denied'))
      .mockResolvedValue(onePage([alice, bob]));

    const accounts = observe(accountPublicKeysQuery(4));
    await afterMs(5_000);

    expect(accounts.getCurrentResult()).toMatchObject({ data: [alice], isError: true });

    await afterMs(4_999);

    expect(queryPurse).toHaveBeenCalledTimes(2);

    await afterMs(1);

    expect(queryPurse).toHaveBeenCalledTimes(3);
    expect(accounts.getCurrentResult()).toMatchObject({ data: [alice, bob], isError: false });
  });

  it('gives the host 15 seconds to return, and starts no second list meanwhile', async () => {
    const queryPurse = hostWithAccounts().mockImplementation(neverAnswers);

    const accounts = observe(accountPublicKeysQuery(4));
    await afterMs(14_999);

    expect(queryPurse).toHaveBeenCalledTimes(1);
    expect(accounts.getCurrentResult().isError).toBe(false);

    await afterMs(1);

    expect(accounts.getCurrentResult().error?.message).toBe('listing the accounts timed out after 15s');
  });

  it('fails outside a host', async () => {
    const accounts = observe(accountPublicKeysQuery(4));
    await settled();

    expect(accounts.getCurrentResult().error?.message).toBe('not inside a Polkadot host');
  });
});

describe('nftsQuery', () => {
  // Alice holds NFT 7 and Bob holds NFT 8.
  function chainWithNfts() {
    const { apis, spies } = fakeAssetHubSession({
      nftsByOwner: new Map([
        [addressOfPublicKey(alice), nft({ instance: 7n })],
        [addressOfPublicKey(bob), nft({ instance: 8n })],
      ]),
    });
    chain.apis = apis;
    return spies.nftsByOwner;
  }

  it('fetches the NFTs of the accounts', async () => {
    chainWithNfts();

    const nfts = observe(nftsQuery([alice, bob]));
    await settled();

    expect(nfts.getCurrentResult().data).toMatchObject([
      { instance: '7', purse: addressOfPublicKey(alice) },
      { instance: '8', purse: addressOfPublicKey(bob) },
    ]);
  });

  it('returns no NFTs for an empty list and asks the chain for nothing', async () => {
    const nfts = observe(nftsQuery([]));
    await settled();

    expect(nfts.getCurrentResult().data).toEqual([]);
    expect(chain.getChainApis).not.toHaveBeenCalled();
  });

  it('does not wait for the art of the NFTs', async () => {
    const { apis } = fakeAssetHubSession({
      nftsByOwner: new Map([[addressOfPublicKey(alice), nft({ instance: 7n })]]),
      metadataByInstance: new Map([['7', metadataLayers({ item: { manifest: text(cid32('m')) } })]]),
    });
    chain.apis = apis;
    art.readManifest.mockImplementation(neverAnswers);

    const nfts = observe(nftsQuery([alice]));
    await settled();

    expect(nfts.getCurrentResult().data).toMatchObject([{ instance: '7', metadata: { manifest: cid32('m') } }]);
    expect(art.readManifest).not.toHaveBeenCalled();
  });

  it('does not wait for the People chain', async () => {
    chainWithNfts();

    observe(nftsQuery([alice]));
    await settled();

    expect(chain.getChainApis).toHaveBeenCalledWith({ waitForPeople: false });
  });

  it('fetches them again 30 seconds after the last read', async () => {
    const nftsByOwner = chainWithNfts();

    observe(nftsQuery([alice]));
    await afterMs(29_999);

    expect(nftsByOwner).toHaveBeenCalledTimes(1);

    await afterMs(1);

    expect(nftsByOwner).toHaveBeenCalledTimes(2);
  });

  it('does not fetch again for an equal list of accounts', async () => {
    const nftsByOwner = chainWithNfts();

    const nfts = observe(nftsQuery([alice]));
    await settled();
    nfts.setOptions(nftsQuery([alice]));
    await settled();

    expect(nftsByOwner).toHaveBeenCalledTimes(1);
  });

  it('fetches the NFTs of a new list at once, and returns the NFTs of the list before until they arrive', async () => {
    const nftsByOwner = chainWithNfts();

    const nfts = observe(nftsQuery([alice]));
    await settled();
    nfts.setOptions(nftsQuery([alice, bob]));

    expect(nfts.getCurrentResult()).toMatchObject({ data: [{ instance: '7' }], isPlaceholderData: true });

    await settled();

    expect(nfts.getCurrentResult()).toMatchObject({
      data: [{ instance: '7' }, { instance: '8' }],
      isPlaceholderData: false,
    });
    expect(nftsByOwner).toHaveBeenCalledTimes(2);
  });

  it('tries a failed read again after 1, 2 and 4 seconds, and starts the next read 30 seconds later', async () => {
    const nftsByOwner = chainWithNfts().mockRejectedValue(new Error('the chain is away'));

    const nfts = observe(nftsQuery([alice]));
    await afterMs(1_000 + 2_000 + 4_000 - 1);

    expect(nftsByOwner).toHaveBeenCalledTimes(3);
    expect(nfts.getCurrentResult().isError).toBe(false);

    await afterMs(1);

    expect(nftsByOwner).toHaveBeenCalledTimes(4);
    expect(nfts.getCurrentResult().error?.message).toBe('the chain is away');

    await afterMs(30_000 - 1);

    expect(nftsByOwner).toHaveBeenCalledTimes(4);

    await afterMs(1);

    expect(nftsByOwner).toHaveBeenCalledTimes(5);
  });

  it('gives a read 30 seconds to finish', async () => {
    chainWithNfts().mockReturnValue(neverAnswers());

    const nfts = observe(nftsQuery([alice]));
    await afterMs(29_999);

    expect(nfts.getCurrentResult().failureCount).toBe(0);

    await afterMs(1);

    expect(nfts.getCurrentResult().failureReason?.message).toBe('the NFT read timed out after 30s');
  });

  it('fails without a chain connection', async () => {
    const nfts = observe(nftsQuery([alice]));
    await settled();

    expect(nfts.getCurrentResult().failureReason?.message).toBe('no chain connection this session');
  });
});

describe('artQuery', () => {
  const [coffee, unserved] = [cid32('coffee'), cid32('unserved')];
  const arrived: FetchedManifest = {
    manifest: parseManifest(manifestDoc('greek-coffee', 'common')),
    transient: false,
  };
  const notServed: FetchedManifest = { manifest: null, transient: true };

  it('fetches the manifest of its CID', async () => {
    art.readManifest.mockResolvedValue(arrived);

    const manifest = observe(artQuery(coffee));
    await settled();

    expect(manifest.getCurrentResult().data).toEqual(arrived);
    expect(art.readManifest.mock.calls.map(([cid]) => cid)).toEqual([coffee]);
  });

  it('does not wait for the manifest of another CID', async () => {
    art.readManifest.mockImplementation((cid: string) =>
      cid === coffee ? answersAfterMs(1_000, arrived) : answersAfterMs(25_000, notServed),
    );

    const served = observe(artQuery(coffee));
    const pending = observe(artQuery(unserved));
    await afterMs(1_000);

    expect(served.getCurrentResult().data).toEqual(arrived);
    expect(pending.getCurrentResult().data).toBeUndefined();
  });

  it('fetches 200 manifests at the same time', async () => {
    art.readManifest.mockImplementation(() => answersAfterMs(1_000, arrived));
    const cids = Array.from({ length: 200 }, (_, i) => cid32(String(i).padStart(3, '0')));

    const manifests = cids.map((cid) => observe(artQuery(cid)));
    await settled();

    expect(new Set(art.readManifest.mock.calls.map(([cid]) => cid)).size).toBe(200);

    await afterMs(1_000);

    expect(manifests.filter((manifest) => manifest.getCurrentResult().data).length).toBe(200);
  });

  it('does not ask again when the art is observed a second time', async () => {
    art.readManifest.mockResolvedValue(arrived);

    observe(artQuery(coffee));
    await settled();
    observe(artQuery(coffee));
    await settled();

    expect(art.readManifest).toHaveBeenCalledTimes(1);
  });

  it('does not ask again for a manifest that was rejected', async () => {
    art.readManifest.mockResolvedValue({ manifest: null, transient: false });

    observe(artQuery(coffee));
    await afterMs(10 * 60_000);

    expect(art.readManifest).toHaveBeenCalledTimes(1);
  });

  it('asks again 30 seconds later while the manifest has not been served', async () => {
    art.readManifest.mockResolvedValueOnce(notServed).mockResolvedValue(arrived);

    const manifest = observe(artQuery(coffee));
    await afterMs(29_999);

    expect(art.readManifest).toHaveBeenCalledTimes(1);
    expect(manifest.getCurrentResult().data).toEqual(notServed);

    await afterMs(1);

    expect(art.readManifest).toHaveBeenCalledTimes(2);
    expect(manifest.getCurrentResult().data).toEqual(arrived);

    await afterMs(10 * 60_000);

    expect(art.readManifest).toHaveBeenCalledTimes(2);
  });
});
