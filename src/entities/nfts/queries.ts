// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// The reads the grid needs, and when each one runs: the stash purse,
// the accounts in it that hold an NFT, the NFTs of those accounts, and the
// art of those NFTs, one query for each manifest.

import { getNftPurseManager, type NftPurseId, type NftPurseItemKey } from '@parity/product-sdk-host';
import { keepPreviousData, QueryClient, type QueryObserverOptions } from '@tanstack/query-core';

import type { FetchedManifest } from '@/entities/art/manifest';
import { getChainApis } from '@/shared/chain/client';
import { addressOfPublicKey } from '@/shared/chain/ss58';
import { withDeadline } from '@/shared/lib/deadline';

import { fetchArt, fetchNfts, formatNfts } from './nfts';
import { HOST_ANSWER_DEADLINE_MS, listAccountPublicKeys, lookUpStashPurse, type StashPurseStatus } from './stashPurse';
import type { OwnedNft } from './types';

/** Runs every query below and keeps their results. */
export const queryClient = new QueryClient();

const ACCOUNT_LIST_INTERVAL_MS = 5_000;
const NFT_READ_INTERVAL_MS = 30_000;
const NFT_READ_DEADLINE_MS = 30_000;
const ART_RETRY_MS = 30_000;

/** Finds or creates the stash purse, once per app start. */
export const stashPurseQuery = {
  queryKey: ['stashPurse'],
  queryFn: lookUpStashPurse,
  staleTime: Infinity,
  // Nothing works without the purse, so a failed lookup is tried again until it succeeds.
  retry: true,
  // The name this read is measured under (reads.ts).
  meta: { read: 'purse' },
} satisfies QueryObserverOptions<StashPurseStatus>;

/** Lists the public keys of the purse's accounts that hold an NFT.
 *  The next list starts 5 seconds after the last one ended. */
export function accountPublicKeysQuery(purseId: NftPurseId) {
  return {
    queryKey: ['stashPurse', purseId, 'accountPublicKeys'],
    queryFn: async () => {
      const purseManager = await getNftPurseManager();
      if (!purseManager) throw new Error('not inside a Polkadot host');

      return withDeadline(
        listAccountPublicKeys(purseManager, purseId),
        HOST_ANSWER_DEADLINE_MS,
        'listing the accounts',
      );
    },
    refetchInterval: ACCOUNT_LIST_INTERVAL_MS,
    // The next list is 5 seconds away, so a failed one is not tried again sooner.
    retry: false,
    meta: { read: 'accounts' },
  } satisfies QueryObserverOptions<NftPurseItemKey[]>;
}

/** Fetches the NFTs of the accounts, at once for a new list of accounts.
 *  The next read starts 30 seconds after the last one ended. */
export function nftsQuery(publicKeys: NftPurseItemKey[]) {
  return {
    queryKey: ['nfts', publicKeys],
    queryFn: async () => {
      // An empty purse needs no chain connection.
      if (publicKeys.length === 0) return [];

      const apis = await getChainApis({ waitForPeople: false });
      if (!apis) throw new Error('no chain connection this session');

      const addresses = publicKeys.map(addressOfPublicKey);
      const raw = await withDeadline(fetchNfts(apis, addresses), NFT_READ_DEADLINE_MS, 'the NFT read');
      return formatNfts(raw);
    },
    refetchInterval: NFT_READ_INTERVAL_MS,
    // A failed read is tried again after 1, 2 and 4 seconds.
    retry: 3,
    // While the NFTs of a new list load, the query keeps returning the NFTs of the list before.
    placeholderData: keepPreviousData,
    meta: { read: 'nfts' },
  } satisfies QueryObserverOptions<OwnedNft[]>;
}

/** Fetches one art manifest. A manifest that no source served is asked for
 *  again 30 seconds after the last try ended. */
export function artQuery(cid: string) {
  return {
    queryKey: ['art', cid],
    queryFn: () => fetchArt(cid),
    // A manifest is addressed by its content, so one that arrived never changes.
    staleTime: Infinity,
    refetchInterval: (query) => (isArtPending(query.state.data) ? ART_RETRY_MS : false),
  } satisfies QueryObserverOptions<FetchedManifest>;
}

const isArtPending = (art: FetchedManifest | undefined) => art !== undefined && !art.manifest && art.transient;
