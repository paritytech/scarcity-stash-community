// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// The catalogue of one collection (Asset Hub): every item it defines, read via
// `getCollectionItems` (attributes: true, the full metadata bag per item),
// paged to exhaustion and resolved through the display path the grid uses
// (art/display.ts).
// `attributes: true` prefix-scans the whole collection's item metadata per
// page, so this is priced for catalogues that fit one MAX_PAGE_LIMIT page.

import { type CollectionItem, getCollectionItems, MAX_PAGE_LIMIT } from '@parity/product-sdk-nfts';

import { type DisplayInput, resolveDisplays } from '@/entities/art/display';
import type { Tier } from '@/entities/art/manifest';
import type { ChainApis } from '@/shared/chain/client';
import { nftsChain, walkPages } from '@/shared/chain/nftsChain';
import { SHOW_AT } from '@/shared/chain/readAt';

/** One item a collection defines, as the grid can show it. */
export interface CatalogueItem {
  itemIndex: number;
  name?: string;
  imageUrl?: string;
  tier?: Tier;
  rare?: boolean;
  metadata?: Record<string, string>;
}

/** A catalogue item as resolver input. The SDK's `name` falls back to the
 *  collection's, so a name equal to the collection's is not the item's own. */
function displayInputOf(item: CollectionItem, collectionName: string | null): DisplayInput {
  return {
    name: item.name === collectionName ? null : item.name,
    collectionName,
    imageRef: item.imageRef,
    attributes: item.attributes ?? {},
  };
}

/** Every item of `collectionId`, in item order, with its display resolved. An
 *  unknown or empty collection yields an empty list. */
export async function fetchCatalogue(apis: ChainApis, collectionId: number): Promise<CatalogueItem[]> {
  const chain = nftsChain(apis);
  const pages = await walkPages(async (cursor) => {
    const page = await getCollectionItems(chain, collectionId, {
      attributes: true,
      limit: MAX_PAGE_LIMIT,
      ...cursor,
    });
    // Callers expect a rejecting promise, not a Result.
    if (!page.ok) throw page.error;
    return page.value.tag === 'NotFound' ? null : page.value;
  }, SHOW_AT);
  const collectionName = pages[0]?.collection.name ?? null;
  const items = pages.flatMap((page) => page.collection.items);
  const displays = await resolveDisplays(items.map((item) => displayInputOf(item, collectionName)));
  return items.map((item, k) => {
    const { name, imageUrl, tier, rare, metadata } = displays[k]!;
    return {
      itemIndex: item.index,
      ...(name ? { name } : {}),
      ...(imageUrl ? { imageUrl } : {}),
      ...(tier ? { tier } : {}),
      ...(rare !== undefined ? { rare } : {}),
      ...(metadata ? { metadata } : {}),
    };
  });
}
