// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// The shape the grid draws a holding in, made from an OwnedNft.

import { chainCollectible, type ResolvedCollectible } from '@/entities/art/resolver';
import { normalizeHash } from '@/shared/lib/hash';

import type { OwnedNft } from './types';

/** A holding ready for the screen. Different hashes often share a picture; the
 *  grid groups those into one piece. */
export interface CollectibleEntry {
  /** Normalized hash (lowercase, no 0x): the entry's id. */
  hash: string;
  /** 0x-prefixed hash for display. */
  hashHex: string;
  /** Unix-seconds mint time, if known; on a credit, its award time. */
  mintedAt?: number;
  /** Unix seconds a held item reached its account: minted or moved in. */
  lastMoved?: number;
  /** Unix seconds the player earned it: a credit's award time, which its NFT
   *  keeps, so a mint never moves a piece. */
  acquiredAt?: number;
  /** On an NFT minted from a credit, that credit's hash, normalized. */
  fromCredit?: string;
  /** True for a credit, not an NFT yet. */
  pending: boolean;
  /** True for a pending credit whose root is on Asset Hub and whose leaf is
   *  unclaimed: a claim can spend it (the mint flow's entry condition). */
  claimable?: boolean;
  /** For a claimable credit, the People-chain block it was awarded in; the
   *  mint flow needs it to re-fetch the inclusion proof at claim time. */
  awardBlock?: number;
  /** Resolved art + rarity + name. */
  resolved: ResolvedCollectible;
  /** The NFT instance in decimal, when the chain read saw it. */
  instance?: string;
  /** The address of the account holding it, when the read went account by account. */
  purse?: string;
  /** Registry id of the mint collection this item belongs to, when known. */
  collectionId?: string;
  /** The item's index within its collection's catalogue, when known. */
  itemIndex?: number;
}

/** An OwnedNft as the screen draws it, from chain data only, with a serial and
 *  the placeholder when its metadata gives no name or picture. */
export function buildEntry(nft: OwnedNft): CollectibleEntry {
  const hash = normalizeHash(nft.hash);
  const hashHex = `0x${hash}`;
  const resolved = chainCollectible(nft.hash, nft.name, nft.imageUrl, {
    tier: nft.tier,
    rare: nft.rare,
    metadata: nft.metadata,
    artPending: nft.artPending,
  });
  const entry: CollectibleEntry = {
    hash,
    hashHex,
    pending: nft.pending === true,
    resolved,
  };
  if (typeof nft.mintedAt === 'number') entry.mintedAt = nft.mintedAt;
  if (typeof nft.lastMoved === 'number') entry.lastMoved = nft.lastMoved;
  if (nft.claimable === true) entry.claimable = true;
  if (typeof nft.awardBlock === 'number') entry.awardBlock = nft.awardBlock;
  if (typeof nft.collectionId === 'string') entry.collectionId = nft.collectionId;
  if (typeof nft.instance === 'string') entry.instance = nft.instance;
  if (typeof nft.purse === 'string') entry.purse = nft.purse;
  if (typeof nft.itemIndex === 'number') entry.itemIndex = nft.itemIndex;
  return entry;
}
