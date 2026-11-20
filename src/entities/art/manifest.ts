// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// The variant manifest an item's `manifest` key names: a JSON document by CID
// that carries the item's archetype, rarity and 512 px thumbnail. Bytes are
// verified against the CID before parsing, a document this version cannot read
// is null, and documents are cached for the session and kept on this device.

import { loadVerifiedContent, verdictOfBytes } from '@/shared/host/content';

import { getArt, putArt, removeArt } from './artStore';

/** A rarity's name, shown as written: the word an item states, or the name
 *  its collection's `rarities` table gives its level (`100=Common,200=Rare`). */
export type Tier = string;

/** One raster asset entry as the manifest states it. */
interface ManifestAsset {
  cid: string;
  mime: string;
  w: number;
  h: number;
  bytes: number;
}

export interface VariantManifest {
  schema: 1;
  collectionId: number;
  archetype: string;
  /** As the document states it: a level the collection's `rarities` table
   *  names, or, in older collections, the name itself (rarityName). */
  rarity: Tier | number;
  assets: {
    thumbnail: ManifestAsset;
  };
}

const CID_RE = /^b[a-z2-7]{20,}$/;
const SLUG_RE = /^[a-z0-9-]{1,64}$/;

/** The table of the older collections, which set no `rarities` and write these
 *  names on their items. */
const DEFAULT_RARITIES = '100=common,200=uncommon,300=rare,400=legendary';

/** A collection's `rarities` value, `100=Common,200=Rare`, as names by level;
 *  the default table when it sets none. */
export function parseRarities(value: string | undefined): Map<number, Tier> {
  const out = new Map<number, Tier>();
  for (const pair of (value ?? '').split(',')) {
    const [level, name] = pair.split('=').map((part) => part.trim());
    if (level && /^\d+$/.test(level) && name) out.set(Number(level), name);
  }
  return out.size > 0 ? out : parseRarities(DEFAULT_RARITIES);
}

/** A `rarity` value as a level, when it is one. */
const levelOf = (rarity: string | number | undefined): number | undefined =>
  typeof rarity === 'number'
    ? Number.isInteger(rarity)
      ? rarity
      : undefined
    : typeof rarity === 'string' && /^\d+$/.test(rarity.trim())
      ? Number(rarity.trim())
      : undefined;

/** The name of an item's `rarity`: its level looked up in the collection's
 *  table. Older collections write the name itself, which comes back as it is. */
export function rarityName(rarity: string | number | undefined, rarities: ReadonlyMap<number, Tier>): Tier | undefined {
  const level = levelOf(rarity);
  if (level !== undefined) return rarities.get(level);
  return typeof rarity === 'string' && rarity.trim() ? rarity.trim() : undefined;
}

/** Compares two rarities by their level in the collection's table: positive
 *  when `a` is rarer, zero when equal or either is unknown. */
export function compareRarities(
  a: string | undefined,
  b: string | undefined,
  rarities: ReadonlyMap<number, Tier>,
): number {
  const levelOfName = (name: string | undefined): number | undefined => {
    const wanted = name?.trim().toLowerCase();
    for (const [level, known] of rarities) if (known.toLowerCase() === wanted) return level;
    return undefined;
  };
  const la = levelOfName(a);
  const lb = levelOfName(b);
  return la === undefined || lb === undefined ? 0 : la - lb;
}

function asset(value: unknown): ManifestAsset | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.cid !== 'string' || !CID_RE.test(v.cid)) return null;
  if (typeof v.mime !== 'string' || !/^image\/(webp|png)$/.test(v.mime)) return null;
  if (typeof v.w !== 'number' || typeof v.h !== 'number' || typeof v.bytes !== 'number') return null;
  return { cid: v.cid, mime: v.mime, w: v.w, h: v.h, bytes: v.bytes };
}

/** The document as a schema 1 manifest, strict on what this app reads and lenient
 *  on the rest; null for anything else. */
export function parseManifest(value: unknown): VariantManifest | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (v.schema !== 1) return null;
  if (typeof v.collectionId !== 'number') return null;
  if (typeof v.archetype !== 'string' || !SLUG_RE.test(v.archetype)) return null;
  const rarity =
    typeof v.rarity === 'number'
      ? Number.isInteger(v.rarity) && v.rarity > 0
        ? v.rarity
        : undefined
      : typeof v.rarity === 'string' && v.rarity.trim() && levelOf(v.rarity) === undefined
        ? v.rarity.trim()
        : undefined;
  if (rarity === undefined) return null;
  if (!v.assets || typeof v.assets !== 'object') return null;
  const a = v.assets as Record<string, unknown>;
  const thumbnail = asset(a.thumbnail);
  if (!thumbnail) return null;
  return {
    schema: 1,
    collectionId: v.collectionId,
    archetype: v.archetype,
    rarity,
    assets: { thumbnail },
  };
}

/** `greek-coffee` → `Greek Coffee`: the title of an item that carries no
 *  `name` of its own. */
export function humanizeArchetype(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** The gateway URL a CID is fetched from. */
function assetUrl(gateway: string, cid: string): string {
  return `${gateway}/ipfs/${cid}`;
}

/** The URL of a manifest's thumbnail: the picture the grid and the detail draw. */
export function thumbnailUrlOf(m: VariantManifest, gateway: string): string {
  return assetUrl(gateway, m.assets.thumbnail.cid);
}

/** One fetch: the parsed document, a final rejection (bytes that are not the
 *  CID's, or not a manifest), or a transient failure worth asking again. */
export interface FetchedManifest {
  manifest: VariantManifest | null;
  transient: boolean;
}

/** CID → the fetch's outcome (a document or a final rejection). Also the
 *  in-flight dedupe. */
const cache = new Map<string, Promise<FetchedManifest>>();

function parsed(bytes: Uint8Array): VariantManifest | null {
  try {
    return parseManifest(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return null;
  }
}

async function fetchManifest(url: string, cid: string): Promise<FetchedManifest> {
  // Kept on this device beside its pictures: it holds their only addresses,
  // which a restart with no byte source still needs.
  const kept = await getArt(cid);
  if (kept) {
    const verdict = await verdictOfBytes(cid, kept.bytes);
    if (verdict === 'verified') return { manifest: parsed(kept.bytes), transient: false };
    // A transient check (the verifier itself failed) must not delete the copy.
    if (verdict === 'rejected') void removeArt(cid);
  }
  const got = await loadVerifiedContent(url, cid);
  if (got.verdict !== 'verified') return { manifest: null, transient: got.verdict === 'transient' };
  const manifest = parsed(got.bytes);
  if (manifest) void putArt(cid, got.bytes, got.type);
  return { manifest, transient: false };
}

/** Fetches, verifies and parses the manifest at `cid`, cached for the session;
 *  a gateway that returned nothing (`transient`) is asked again next call. */
export function readManifest(cid: string, gateway: string): Promise<FetchedManifest> {
  if (!CID_RE.test(cid)) return Promise.resolve({ manifest: null, transient: false });
  const hit = cache.get(cid);
  if (hit) return hit;
  const pending = fetchManifest(assetUrl(gateway, cid), cid).then((r) => {
    if (r.transient) cache.delete(cid);
    return r;
  });
  cache.set(cid, pending);
  return pending;
}
