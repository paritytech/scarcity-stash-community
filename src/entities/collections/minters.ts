// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// The collections registered to accept claims (`NftClaims.CollectionMinters`),
// read with the SDK's `getClaimableCollections` at one block, every page. Each
// sets how the item is chosen: Random (the credit hash modulo the item count,
// so the preview is exact) or Contract.

import { getClaimableCollections, MAX_PAGE_LIMIT } from '@parity/product-sdk-nfts';

import { type ChainApis, getChainApis } from '@/shared/chain/client';
import { nftsChain, walkPages } from '@/shared/chain/nftsChain';
import { SHOW_AT } from '@/shared/chain/readAt';

/** A collection the player may spend a credit into. */
export interface MintCollection {
  id: number;
  /** Collection metadata `name`, when set (else the UI shows "Collection <id>"). */
  name?: string;
  /** How many distinct items it defines; absent when its record could not be
   *  read. */
  itemCount?: number;
}

/** Every collection registered to accept claims, in id order (the SDK walk
 *  ascends the id space), names resolved. Walks every page. */
export async function fetchMintCollections(apis: ChainApis): Promise<MintCollection[]> {
  const chain = nftsChain(apis);
  const pages = await walkPages(async (cursor) => {
    const page = await getClaimableCollections(chain, { limit: MAX_PAGE_LIMIT, ...cursor });
    // Callers expect a rejecting promise, not a Result.
    if (!page.ok) throw page.error;
    return page.value;
  }, SHOW_AT);
  return pages.flatMap((page) =>
    page.collections.map((c) => {
      const out: MintCollection = { id: c.id };
      // `null` when unset; registry.ts shows "Collection <id>" for an absent one.
      if (c.name) out.name = c.name;
      if (typeof c.itemCount === 'number') out.itemCount = c.itemCount;
      return out;
    }),
  );
}

/** The collections registered to accept claims, with names resolved. */
export async function loadMintCollections(): Promise<MintCollection[]> {
  const apis = await getChainApis();
  if (!apis) throw new Error('no chain connection this session');
  return fetchMintCollections(apis);
}
