// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// What an item looks like, from the metadata the chain holds for it. Every
// source (a minted NFT, a catalogue item, a mint preview) lands here as one
// DisplayInput, the SDK's shape, so all of them show an item the same way. The
// keys this app reads (`manifest`, `archetype`, `rarity`) live in the
// attribute bag.

import type { ImageRef } from '@parity/product-sdk-nfts';
import { artworkAddress } from '@parity/product-sdk-nfts';

import { IPFS_GATEWAY } from '@/shared/chain/network';

import {
  compareRarities,
  type FetchedManifest,
  humanizeArchetype,
  parseRarities,
  rarityName,
  readManifest,
  thumbnailUrlOf,
  type Tier,
} from './manifest';
import { cidFromUrl } from './verifiedArt';

/** What every display source passes the resolver, in the SDK's shape: a
 *  Found InstanceDisplay satisfies it as is. */
export interface DisplayInput {
  /** The item's own name (instance or item layer), never the collection's. */
  name: string | null;
  collectionName: string | null;
  imageRef: ImageRef | null;
  /** Every key, most specific layer winning, values text or 0x-hex. The
   *  tier reads from its `rarity` here. */
  attributes: Record<string, string>;
}

/** Everything the metadata holds about an item. The manifest's thumbnail
 *  replaces `imageUrl` once it is fetched and verified (resolveDisplays). */
export interface Display {
  name?: string;
  imageUrl?: string;
  tier?: Tier;
  /** Whether the tier is rarer than its collection's commonest (rarerThanCommonest). */
  rare?: boolean;
  manifest?: string;
  archetype?: string;
  /** The item names a manifest that no source served this time: its picture
   *  is on its way, and the next read asks again. */
  artPending?: boolean;
  /** Every metadata key the item resolves to, most specific layer winning,
   *  as text (hex when a value is not UTF-8). The detail view lists them. */
  metadata?: Record<string, string>;
}

const CID_TEXT = /^b[a-z2-7]{20,}$/;

/** The display name and artwork URL an item's metadata carries. An unset key
 *  yields undefined, a non-fetchable image yields no URL. */
export function resolveDisplay(input: DisplayInput): Display {
  const out: Display = {};
  const { attributes } = input;
  if (Object.keys(attributes).length > 0) out.metadata = attributes;
  const archetype = archetypeOf(attributes);
  if (archetype) out.archetype = archetype;
  // The item's own title first, then its archetype. The collection's `name`
  // is the collection's, so it only stands in when the item has neither.
  if (input.name) out.name = input.name;
  else if (out.archetype) out.name = humanizeArchetype(out.archetype);
  else if (input.collectionName) out.name = input.collectionName;
  if (input.imageRef) {
    const url = imageUrlOfRef(input.imageRef);
    if (url) out.imageUrl = url;
  }
  const rarity = attributes.rarity;
  if (rarity !== undefined) {
    const table = parseRarities(attributes.rarities);
    const tier = rarityName(rarity, table);
    if (tier) {
      out.tier = tier;
      out.rare = rarerThanCommonest(tier, table);
    }
  }
  const manifest = manifestCidOf(attributes);
  if (manifest) out.manifest = manifest;
  return out;
}

/** The archetype slug an item's metadata states, when it reads as a slug. */
function archetypeOf(attributes: Record<string, string>): string | undefined {
  const archetype = attributes.archetype;
  return archetype !== undefined && /^[a-z0-9-]{1,64}$/.test(archetype) ? archetype : undefined;
}

/** The manifest CID an item's metadata states, when it reads as a CID. */
export function manifestCidOf(attributes: Record<string, string>): string | undefined {
  const manifest = attributes.manifest;
  return manifest !== undefined && CID_TEXT.test(manifest) ? manifest : undefined;
}

/** Whether `tier` is rarer than the commonest tier of `table`. */
const rarerThanCommonest = (tier: Tier, table: ReadonlyMap<number, Tier>): boolean =>
  compareRarities(tier, table.get(Math.min(...table.keys())), table) > 0;

/** resolveDisplay for many items, each with its manifest fetched and folded in
 *  (withManifest). Manifests are cached by CID. */
export function resolveDisplays(inputs: DisplayInput[]): Promise<Display[]> {
  return Promise.all(
    inputs.map(async (input) => {
      const display = resolveDisplay(input);
      if (!display.manifest) return display;
      return withManifest(display, input.attributes, await readManifest(display.manifest, IPFS_GATEWAY));
    }),
  );
}

/** What a manifest can fill in, on a display or on an NFT. */
type Look = Pick<Display, 'name' | 'imageUrl' | 'tier' | 'rare' | 'artPending'>;

/** `look` with its manifest folded in: the thumbnail becomes the picture. A
 *  manifest that contradicts the chain's archetype or tier is ignored. */
export function withManifest<SomeLook extends Look>(
  look: SomeLook,
  attributes: Record<string, string>,
  { manifest, transient }: FetchedManifest,
): SomeLook {
  if (!manifest) return transient ? { ...look, artPending: true } : look;

  const archetype = archetypeOf(attributes);
  if (archetype && manifest.archetype !== archetype) return look;

  const table = parseRarities(attributes.rarities);
  const stated = rarityName(manifest.rarity, table);
  if (look.tier && stated?.toLowerCase() !== look.tier.toLowerCase()) return look;

  const withArt: SomeLook = { ...look, imageUrl: thumbnailUrlOf(manifest, IPFS_GATEWAY) };
  if (!look.tier && stated) {
    withArt.tier = stated;
    withArt.rare = rarerThanCommonest(stated, table);
  }
  if (!look.name) withArt.name = humanizeArchetype(manifest.archetype);
  return withArt;
}

/** An `image` text as a fetchable URL: its content id, bare or inside a link,
 *  through this network's gateway. Anything else undefined. */
export function imageUrlOf(value: string): string | undefined {
  const v = value.trim();
  const cid = CID_TEXT.test(v) ? v : cidFromUrl(v);
  return cid ? `${IPFS_GATEWAY}/ipfs/${cid}` : undefined;
}

/** An `image` value as a fetchable URL: its text through imageUrlOf, else its
 *  bare 32-byte digest wrapped back into a CID (the SDK's artworkAddress). */
export function imageUrlOfRef(ref: ImageRef): string | undefined {
  const fromText = ref.text === null ? undefined : imageUrlOf(ref.text);
  if (fromText) return fromText;
  const cid = artworkAddress(ref)?.cid;
  return cid ? `${IPFS_GATEWAY}/ipfs/${cid}` : undefined;
}
