// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// What a holding shows, from chain data only: its name and picture from its
// metadata (display.ts); its glow, and its rarity when no tier is stated, from
// the hash bytes.

import { normalizeHash, shortCode } from '@/shared/lib/hash';

import type { Tier } from './manifest';

/** A hash whose first two bytes read below this is rare, about 12%. Never
 *  change it: it would reclassify NFTs players already hold. */
const RARE_THRESHOLD = 7865;

export interface ResolvedCollectible {
  /** Artwork URL, ready to drop into an <img src>. The shared "?"
   *  placeholder when the item carries no `image` metadata. */
  url: string;
  /** Display name from the `name` metadata key, else a serial code. */
  name: string;
  /** 1-based place of the item in its collection; 0 until the collection read returns it. */
  collectionIndex: number;
  /** The tier the item's `rarity` metadata states, when it has one. */
  tier?: Tier;
  /** Every on-chain metadata key the item resolves to, for the detail's list. */
  metadata?: Record<string, string>;
  /** Rare by the item's tier when it states one, else by the hash's rarity roll. */
  isRare: boolean;
  /** The glow colour as "R G B", from the hash bytes; feeds the `--glow` CSS
   *  variable. */
  glow: string;
  /** False when `url` is the "?" placeholder; the grid then leaves `url` out of
   *  the piece's artwork key. */
  hasArt?: boolean;
  /** The item names a manifest that was not served this time: its picture
   *  is on its way rather than missing. */
  artPending?: boolean;
}

/** Parse a uint16 from two consecutive bytes at the given byte offset. */
function uint16At(hex: string, byteOffset: number): number {
  const start = byteOffset * 2;
  const hi = parseInt(hex.slice(start, start + 2), 16);
  const lo = parseInt(hex.slice(start + 2, start + 4), 16);
  if (!Number.isFinite(hi) || !Number.isFinite(lo)) return 0;
  return ((hi & 0xff) << 8) | (lo & 0xff);
}

/** The "?" shown when an item has no picture on chain yet. Transparent, so it
 *  floats on the glow the way cut-out artwork does. */
const PLACEHOLDER_ART =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">' +
      '<circle cx="256" cy="256" r="150" fill="rgba(255,255,255,0.05)"/>' +
      '<circle cx="256" cy="256" r="150" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="2"/>' +
      '<text x="256" y="316" font-size="170" font-weight="700" text-anchor="middle" ' +
      'fill="rgba(255,255,255,0.35)" font-family="system-ui">?</text>' +
      '</svg>',
  );

/** A ResolvedCollectible from chain data only, with a serial code and the "?"
 *  placeholder when the metadata gives no name or picture. */
export function chainCollectible(
  hashHex: string,
  name: string | undefined,
  url: string | undefined,
  extra: {
    tier?: Tier;
    rare?: boolean;
    metadata?: Record<string, string>;
    artPending?: boolean;
  } = {},
): ResolvedCollectible {
  const hex = normalizeHash(hashHex || '');
  const valid = /^[0-9a-f]{64}$/.test(hex);
  // A stated tier wins over the hash roll: rare above the collection's
  // commonest, or, with only a name, when that name is not `common`.
  const rare = extra.rare ?? (extra.tier ? extra.tier.toLowerCase() !== 'common' : undefined);
  const isRare = rare ?? (valid && uint16At(hex, 0) < RARE_THRESHOLD);
  // Deterministic glow from hash bytes 4-6, lifted into a soft range so
  // dark hashes still halo visibly.
  const glow = valid
    ? [4, 5, 6].map((i) => 90 + (parseInt(hex.slice(i * 2, i * 2 + 2), 16) % 128)).join(' ')
    : '138 132 168';
  // The serial the piece's badge shows, so a fallback name matches its badge.
  const code = hex ? shortCode(hex) : 'UNKNOWN';
  return {
    url: url ?? PLACEHOLDER_ART,
    ...(extra.tier ? { tier: extra.tier } : {}),
    ...(extra.metadata ? { metadata: extra.metadata } : {}),
    name: name ?? `Collectible ${code}`,
    collectionIndex: 0,
    isRare,
    glow,
    hasArt: Boolean(url),
    ...(!url && extra.artPending ? { artPending: true } : {}),
  };
}

/** The word on the rarity chip: the tier the `rarity` metadata states, else
 *  the hash roll's Rare / Standard. */
export function tierLabel(item: Pick<ResolvedCollectible, 'tier' | 'isRare'>): string {
  if (item.tier) return item.tier.charAt(0).toUpperCase() + item.tier.slice(1);
  return item.isRare ? 'Rare' : 'Standard';
}
