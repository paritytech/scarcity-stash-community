// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// The session's connection in the shape product-sdk-nfts takes. There is no
// cast: an entry the SDK needs but `.papi/whitelist.ts` prunes fails `tsc`.
// Every SDK read takes `at`, a block name (readAt.ts) or a pinned snapshot, so
// a walk over pages reads one chain state.

import type {
  BlockAt,
  BlockSnapshot,
  BlockSource,
  FinalizedSnapshot,
  NftsChain,
  NftsCreditsChain,
  NftsInstancesChain,
} from '@parity/product-sdk-nfts';

import type { ChainApis } from './client';
import type { ReadBlock } from './readAt';

/** The Asset Hub half, which every catalogue read and the NFT read take. */
export function nftsChain(apis: ChainApis): NftsChain & NftsInstancesChain {
  return {
    assetHub: apis.assetHub,
    raw: { assetHub: apis.raw.assetHub },
  };
}

/** Both halves: the claims read joins People ("individuality") to Asset Hub.
 *  Null without a People connection; the grid then shows NFTs only. */
export function nftsCreditsChain(apis: ChainApis): (NftsChain & NftsCreditsChain) | null {
  if (!apis.people || !apis.raw.people) return null;
  return {
    assetHub: apis.assetHub,
    individuality: apis.people,
    raw: { assetHub: apis.raw.assetHub, individuality: apis.raw.people },
  };
}

/** The block `at` names right now, pinned, so a read of several calls is served
 *  from one chain state. */
export async function pinBlock(raw: BlockSource, at: ReadBlock): Promise<BlockSnapshot> {
  const block = at === 'best' ? (await raw.getBestBlocks())[0] : await raw.getFinalizedBlock();
  if (!block) throw new Error('the chain client reported no best block');
  return { blockHash: block.hash, blockNumber: block.number };
}

/** One step of a paged read: the next `fromId`, and the block the first page
 *  pinned. */
export interface PageCursor {
  fromId?: number;
  at: BlockAt;
}

/** Walks a paged SDK read to its end at one block, the one the first page
 *  pinned. `fetchPage` throws on an error and may return null to stop early. */
export async function walkPages<Page extends { at: FinalizedSnapshot; nextId: number | null }>(
  fetchPage: (cursor: PageCursor) => Promise<Page | null>,
  at: BlockAt,
): Promise<Page[]> {
  const pages: Page[] = [];
  const cursor: PageCursor = { at };
  for (;;) {
    const page = await fetchPage(cursor);
    if (page === null) return pages;
    pages.push(page);
    if (page.nextId === null) return pages;
    // A name like 'best' pins a block per call; the snapshot it pinned is
    // what later pages must read at.
    cursor.at = page.at;
    cursor.fromId = page.nextId;
  }
}
