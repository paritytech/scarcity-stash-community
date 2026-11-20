// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// What each credit would mint: the result of `NftClaimsApi.preview_mints` for
// the credit in one collection, kept on the credit's record under that
// collection (`collectionItems`). The sync reads it for each credit in the
// collection it goes to, once in each session, and again while the picture of
// its item was not served (features/holdings/sync.ts).

import { chainCollectible } from '@/entities/art/resolver';
import {
  type Collectible,
  type CollectionItemRead,
  selectedCollectionItemOf,
  SESSION_STARTED_AT,
} from '@/entities/nfts/collectibles';

import { loadMintPreviewsMany, type MintPreview, type PreviewPair } from './preview';

/** One preview as a record keeps it. Its time is never before this session's
 *  start, even when the device's clock was set back since. */
function formatCollectionItem(pair: PreviewPair, { outcome }: MintPreview): CollectionItemRead {
  const item =
    outcome.kind === 'mints'
      ? {
          ...chainCollectible(pair.credit, outcome.name, outcome.imageUrl, {
            ...(outcome.tier ? { tier: outcome.tier } : {}),
            ...(outcome.rare !== undefined ? { rare: outcome.rare } : {}),
            ...(outcome.metadata ? { metadata: outcome.metadata } : {}),
            ...(outcome.artPending ? { artPending: true } : {}),
          }),
          collectionIndex: outcome.item + 1,
        }
      : null;
  return {
    credit: pair.credit,
    collectionId: String(pair.collection),
    item,
    readAt: Math.max(Date.now(), SESSION_STARTED_AT),
  };
}

/** Fetches what each credit of `pairs` would mint in its collection. */
export async function fetchCollectionItems(pairs: PreviewPair[]): Promise<CollectionItemRead[]> {
  if (pairs.length === 0) return [];
  const previews = await loadMintPreviewsMany(pairs);
  return previews.map((preview, i) => formatCollectionItem(pairs[i]!, preview));
}

type Records = Readonly<Record<string, Collectible>>;

/** Whether `record` is a credit whose item, in the collection it goes to, was
 *  not read in this session. */
function isItemUnread(record: Collectible): boolean {
  if (record.type !== 'credit' || record.selectedCollectionId === undefined) return false;
  const read = selectedCollectionItemOf(record);
  return !read || read.readAt < SESSION_STARTED_AT;
}

/** Whether `record` is a credit whose item was read without its picture,
 *  which may be served by now. */
const isPictureComing = (record: Collectible): boolean =>
  record.type === 'credit' && selectedCollectionItemOf(record)?.item?.artPending === true;

/** Whether some credit's item, in the collection it goes to, was not read in
 *  this session. */
export const hasUnreadItems = (records: Records): boolean => Object.values(records).some(isItemUnread);

/** The credits whose item is to be read now, each with the collection it goes
 *  to: those not read in this session, and those whose picture is still to come. */
export function listPairsToPreview(records: Records): PreviewPair[] {
  return Object.values(records)
    .filter((r) => r.credit && (isItemUnread(r) || isPictureComing(r)))
    .map((r) => ({ credit: `0x${r.credit!.hash}`, collection: Number(r.selectedCollectionId) }));
}
