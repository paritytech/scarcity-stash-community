// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// The NFT as the reads deliver it and the device keeps it.

import type { Tier } from '@/entities/art/manifest';

/** One NFT the player holds, or a credit in the same shape (`pending`). Its
 *  name and picture come from its metadata. */
export interface OwnedNft {
  /** The 32-byte hash as hex, `0x` optional, any case. A malformed one still
   *  draws, with the placeholder. */
  hash: string;
  /** Unix seconds it was minted; on a credit, when its tree was rooted. Without
   *  it the item sorts last. */
  mintedAt?: number;
  /** Unix seconds it reached the account holding it: its mint, or the last move
   *  into it (`last_moved`). New counts from it. */
  lastMoved?: number;
  /** A credit, not an NFT yet. */
  pending?: boolean;
  /** A credit whose root is on Asset Hub and whose leaf is unclaimed: a claim
   *  can spend it. */
  claimable?: boolean;
  /** The NFT instance in decimal, when the read saw it on chain. */
  instance?: string;
  /** The address of the account holding it, when the read went account by
   *  account: what another app needs to show it. */
  purse?: string;
  /** On-chain display name (three-level metadata key `name`), when the
   *  chain-read path resolved one. Without it the item shows a serial code. */
  name?: string;
  /** Resolved artwork URL (from the metadata key `image`, served via the
   *  IPFS gateway). Without it the item shows the "?" placeholder. */
  imageUrl?: string;
  /** The item's manifest was not served this time, so its picture is on its
   *  way: the grid shows a loading look, never the "?" placeholder. */
  artPending?: boolean;
  /** The rarity tier its metadata states (key `rarity`), when the item
   *  has one. Without it the tier is derived from the hash bytes. */
  tier?: Tier;
  /** Whether that tier is above its collection's commonest. Without it the
   *  name decides: anything but `common` counts as rare. */
  rare?: boolean;
  /** Every on-chain metadata key the item resolves to, as text. */
  metadata?: Record<string, string>;
  /** On a credit, the People block it was awarded in, which a claim names to
   *  fetch its proof. */
  awardBlock?: number;
  /** The collection's chain id as a string; every NFT read carries it. */
  collectionId?: string;
  /** The item's index within its collection's catalogue (the chain's
   *  ItemIndex). */
  itemIndex?: number;
}
