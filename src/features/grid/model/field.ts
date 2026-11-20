// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// The grid's model: where every piece sits, and what the player knows of it,
// pure so it is tested without a DOM. The layout comes from the catalogues and
// moves only when one changes; the overlay comes from the holdings on every
// read. A missing piece's name never leaves the catalogue, so no screen can
// show it. A credit stands at the cell of the item it would mint.

import { parseRarities } from '@/entities/art/manifest';
import type { CatalogueItem } from '@/entities/collections/catalogue';
import type { CatalogueSlot } from '@/entities/collections/catalogueStore';
import type { CollectibleEntry } from '@/entities/nfts/format';

export interface FieldCollection {
  id: string;
  name: string;
  /** The name is still being read: `name` holds a stand-in and the title draws as a bar. */
  nameLoading?: boolean;
}

interface Cell {
  /** Stable across reads: the collection and the artwork. */
  key: string;
  collectionId: string;
  area: number;
  /** "No. 12 of 47": the artwork's place in its catalogue. Absent on a cell for an
   *  owned item the catalogue does not list, or when it could not be read. */
  no?: number;
  of?: number;
  tier?: string;
  rare: boolean;
  /** The catalogue item indexes the cell stands for. */
  items: number[];
  /** The artwork's small picture: drawn as a silhouette or a showcase bloom,
   *  never with a name. */
  imageUrl?: string;
}

export interface Area {
  idx: number;
  /** The tier label, or the collection's name when it has one tier. */
  name: string;
  region: number;
  from: number;
  to: number;
  n: number;
  /** Where the area is, in world units of one piece: 0 until the grid places
   *  it (engine/grid.ts placeGrid). */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Region {
  idx: number;
  id: string;
  name: string;
  /** The collection's name is still being read: `name` holds a stand-in. */
  nameLoading?: boolean;
  areas: number[];
  /** Where the region starts and how tall it is, in world units of one piece:
   *  0 until the grid places it (engine/grid.ts placeGrid). */
  y: number;
  h: number;
  /** The catalogue is not in: the region shows the owned pieces alone. */
  partial: boolean;
  /** Why it is not: still being read, the read failed (it retries), or the
   *  collection is too large to read whole. */
  partialWhy?: 'loading' | 'failed' | 'skipped';
  /** A description every item of the collection carries is the collection's,
   *  not any one item's. */
  sharedDescription?: string;
}

export interface FieldLayout {
  /** Changes whenever any cell moves. */
  key: string;
  cells: Cell[];
  areas: Area[];
  regions: Region[];
  /** Each cell's centre, in world units of one piece: 0 until the grid places
   *  it (engine/grid.ts placeGrid). */
  px: Float32Array;
  py: Float32Array;
  areaOf: Int16Array;
  index: ReadonlyMap<string, number>;
}

const tierWord = (t: string): string => t.charAt(0).toUpperCase() + t.slice(1);

/** What makes two definitions the same artwork: the manifest they point at,
 *  else the name, tier and picture they show. */
function artworkKey(item: Pick<CatalogueItem, 'metadata' | 'name' | 'tier' | 'imageUrl'>): string {
  return item.metadata?.manifest ?? `${item.name ?? ''}|${item.tier ?? ''}|${item.imageUrl ?? ''}`;
}

/** A cell's key part for an artwork, hashed, since it may fall back to a name
 *  the player has not found yet. */
function artKey(item: Pick<CatalogueItem, 'metadata' | 'name' | 'tier' | 'imageUrl'>): string {
  const s = artworkKey(item);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return h1.toString(36) + h2.toString(36);
}

interface DraftCell extends Omit<Cell, 'area'> {
  tierKey: string;
}

/** The cells of one collection in catalogue order, identical definitions folded. */
function catalogueCells(collectionId: string, items: readonly CatalogueItem[]): DraftCell[] {
  const byArt = new Map<string, DraftCell>();
  const out: DraftCell[] = [];
  for (const item of items) {
    const art = artKey(item);
    const hit = byArt.get(art);
    if (hit) {
      hit.items.push(item.itemIndex);
      continue;
    }
    const cell: DraftCell = {
      key: `${collectionId}/${art}`,
      collectionId,
      rare: item.rare ?? (item.tier ? item.tier.toLowerCase() !== 'common' : false),
      items: [item.itemIndex],
      tierKey: (item.tier ?? '').toLowerCase(),
      ...(item.tier ? { tier: item.tier } : {}),
      ...(item.imageUrl ? { imageUrl: item.imageUrl } : {}),
    };
    byArt.set(art, cell);
    out.push(cell);
  }
  out.forEach((c, k) => {
    c.no = k + 1;
    c.of = out.length;
  });
  return out;
}

/** An owned entry's artwork key part, the same one its catalogue item gets. */
function entryArt(e: CollectibleEntry): string {
  const r = e.resolved;
  return artKey({
    ...(r.metadata ? { metadata: r.metadata } : {}),
    name: r.name,
    ...(r.tier ? { tier: r.tier } : {}),
    ...(r.hasArt !== false ? { imageUrl: r.url } : {}),
  });
}

/** Cells for held items the catalogue does not list yet, keyed as it would
 *  key them, so a late catalogue finds the same cell. */
function heldCells(
  collectionId: string,
  entries: readonly CollectibleEntry[],
  listed: readonly DraftCell[] = [],
): DraftCell[] {
  const byArt = new Map<string, DraftCell>();
  for (const c of listed) byArt.set(c.key, c);
  const out: DraftCell[] = [];
  for (const e of entries) {
    const key = `${collectionId}/${entryArt(e)}`;
    const r = e.resolved;
    const hit = byArt.get(key);
    if (hit) {
      if (typeof e.itemIndex === 'number' && !hit.items.includes(e.itemIndex)) hit.items.push(e.itemIndex);
      continue;
    }
    const cell: DraftCell = {
      key,
      collectionId,
      rare: r.isRare,
      items: typeof e.itemIndex === 'number' ? [e.itemIndex] : [],
      tierKey: (r.tier ?? '').toLowerCase(),
      ...(r.tier ? { tier: r.tier } : {}),
    };
    byArt.set(key, cell);
    out.push(cell);
  }
  return out;
}

/** Tier order for a collection: by level in its `rarities` table, unknown
 *  tiers after the known ones in the order first seen. */
function tierOrder(cells: readonly DraftCell[], rarities: string | undefined): string[] {
  const levels = parseRarities(rarities);
  const levelOf = new Map<string, number>();
  for (const [level, name] of levels) levelOf.set(name.toLowerCase(), level);
  const seen: string[] = [];
  for (const c of cells) if (!seen.includes(c.tierKey)) seen.push(c.tierKey);
  return seen
    .map((t, k) => ({ t, k, level: levelOf.get(t) }))
    .sort((a, b) => {
      if (a.level !== undefined && b.level !== undefined) return a.level - b.level;
      if (a.level !== undefined) return -1;
      if (b.level !== undefined) return 1;
      return a.k - b.k;
    })
    .map((x) => x.t);
}

const sharedDescriptionOf = (items: readonly CatalogueItem[]): string | undefined => {
  const first = items[0]?.metadata?.description;
  if (!first || items.length < 2) return undefined;
  return items.every((i) => i.metadata?.description === first) ? first : undefined;
};

/** Where every piece sits, in the order of `collections`; `owned` places what
 *  no catalogue lists yet, credits included, so a credit keeps its cell. */
export function buildFieldLayout(
  collections: readonly FieldCollection[],
  catalogues: Readonly<Record<string, CatalogueSlot | undefined>>,
  owned: readonly CollectibleEntry[],
): FieldLayout {
  const ownedBy = new Map<string, CollectibleEntry[]>();
  for (const e of owned) {
    if (!e.collectionId) continue;
    const list = ownedBy.get(e.collectionId);
    if (list) list.push(e);
    else ownedBy.set(e.collectionId, [e]);
  }

  interface DraftRegion {
    c: FieldCollection;
    areas: { name: string; cells: DraftCell[] }[];
    partial: boolean;
    why?: 'loading' | 'failed' | 'skipped';
    shared?: string;
  }
  const drafts: DraftRegion[] = [];
  for (const c of collections) {
    const slot = catalogues[c.id];
    const items = slot?.items ?? null;
    const held = ownedBy.get(c.id) ?? [];
    let cells: DraftCell[];
    if (items && items.length > 0) {
      cells = catalogueCells(c.id, items);
      const listed = new Set(items.map((i) => i.itemIndex));
      const orphans = held.filter((e) => typeof e.itemIndex !== 'number' || !listed.has(e.itemIndex));
      cells = cells.concat(heldCells(c.id, orphans, cells));
    } else {
      cells = heldCells(c.id, held);
    }
    if (cells.length === 0) continue;
    const order = tierOrder(cells, items?.[0]?.metadata?.rarities ?? held[0]?.resolved.metadata?.rarities);
    const single = order.length === 1;
    const areas = order.map((t) => {
      const list = cells.filter((x) => x.tierKey === t);
      const sample = list.find((x) => x.tier)?.tier;
      return { name: single ? c.name : sample ? tierWord(sample) : 'Standard', cells: list };
    });
    const shared = items ? sharedDescriptionOf(items) : undefined;
    const partial = !items || items.length === 0;
    const why = !partial
      ? undefined
      : slot?.status === 'failed'
        ? 'failed'
        : slot?.status === 'skipped'
          ? 'skipped'
          : slot?.status === 'ready'
            ? undefined
            : 'loading';
    drafts.push({
      c,
      areas,
      partial,
      ...(why ? { why } : {}),
      ...(shared ? { shared } : {}),
    });
  }

  const regions: Region[] = [];
  const areas: Area[] = [];
  const cells: Cell[] = [];
  const total = drafts.reduce((n, r) => n + r.areas.reduce((m, a) => m + a.cells.length, 0), 0);
  const areaOf = new Int16Array(total);
  const index = new Map<string, number>();
  for (const r of drafts) {
    const region: Region = {
      idx: regions.length,
      id: r.c.id,
      name: r.c.name,
      ...(r.c.nameLoading ? { nameLoading: true } : {}),
      areas: [],
      y: 0,
      h: 0,
      partial: r.partial,
      ...(r.why ? { partialWhy: r.why } : {}),
      ...(r.shared ? { sharedDescription: r.shared } : {}),
    };
    regions.push(region);
    for (const a of r.areas) {
      const area: Area = {
        idx: areas.length,
        name: a.name,
        region: region.idx,
        from: cells.length,
        to: cells.length + a.cells.length,
        n: a.cells.length,
        x: 0,
        y: 0,
        w: 0,
        h: 0,
      };
      areas.push(area);
      region.areas.push(area.idx);
      for (const d of a.cells) {
        const i = cells.length;
        const { tierKey: _t, ...cell } = d;
        cells.push({ ...cell, area: area.idx });
        index.set(cell.key, i);
        areaOf[i] = area.idx;
      }
    }
  }
  const key =
    regions.map((r) => `${r.id}:${r.partial ? 'p' : 'c'}`).join('|') + '#' + cells.map((c) => c.key).join(',');
  return { key, cells, areas, regions, px: new Float32Array(total), py: new Float32Array(total), areaOf, index };
}

/** What the player sees of a piece they hold or have a credit for: never present for
 *  a missing one. */
interface PieceLook {
  name: string;
  imageUrl?: string;
  /** The picture is on its way rather than missing. */
  artPending?: boolean;
  entry: CollectibleEntry;
}

export interface PieceState {
  /** owned: held now. credit: only credits stand here, no NFT minted from them
   *  yet, and the piece counts as found. missing: neither. */
  status: 'owned' | 'credit' | 'missing';
  /** Copies the player holds now. */
  copies: number;
  /** The held copies, newest first. */
  entries: CollectibleEntry[];
  /** Unix seconds of the earliest held copy or credit. */
  foundAt?: number;
  /** Something here reached the player in the last 12 hours (isNewAt): what
   *  the New button counts and shows. */
  isNew: boolean;
  /** Held copies this device hasn't shown before: they fly in when the grid
   *  opens. */
  newCopies: number;
  /** The credits that would mint into this piece, newest first. */
  credits: CollectibleEntry[];
  look?: PieceLook;
}

const MISSING: PieceState = {
  status: 'missing',
  copies: 0,
  entries: [],
  isNew: false,
  newCopies: 0,
  credits: [],
};

const when = (e: CollectibleEntry): number | undefined => e.acquiredAt ?? e.mintedAt;

/** How long a credit or piece stays in New after it arrived, in seconds. */
export const NEW_FOR = 12 * 60 * 60;

/** When `e` reached the player, by the chain's times so every device agrees:
 *  an NFT's arrival in its account, a credit's root; none before a root. */
const arrivedAt = (e: CollectibleEntry): number | undefined => (e.pending ? e.mintedAt : e.lastMoved);

/** Whether `e` arrived less than NEW_FOR before `now`. A credit with no root
 *  yet is new; an NFT whose arrival no read brought is not. */
export function isNewAt(e: CollectibleEntry, now: number): boolean {
  const at = arrivedAt(e);
  return at === undefined ? e.pending : now - at < NEW_FOR;
}

/** When the next of `entries` leaves New, Unix seconds, judged at `now`: the
 *  soonest to turn NEW_FOR old. Undefined while none will. */
export function nextAgeOut(entries: readonly CollectibleEntry[], now: number): number | undefined {
  let next: number | undefined;
  for (const e of entries) {
    const at = arrivedAt(e);
    if (at === undefined || now - at >= NEW_FOR) continue;
    if (next === undefined || at + NEW_FOR < next) next = at + NEW_FOR;
  }
  return next;
}

/** The cell an entry belongs to: by collection and item index, else by its
 *  artwork (an item the catalogue does not list, or one with no index). */
function cellOf(layout: FieldLayout, byItem: ReadonlyMap<string, number>, e: CollectibleEntry): number | undefined {
  if (!e.collectionId) return undefined;
  const hit = typeof e.itemIndex === 'number' ? byItem.get(`${e.collectionId}#${e.itemIndex}`) : undefined;
  return hit ?? layout.index.get(`${e.collectionId}/${entryArt(e)}`);
}

/** Every cell's state from the drawn holdings, with New judged at `now`. A
 *  credit stands at its preview's cell, or nowhere without a collection. */
export function overlayField(
  layout: FieldLayout,
  entries: readonly CollectibleEntry[],
  unseen: ReadonlySet<string>,
  now: number,
): PieceState[] {
  const byItem = new Map<string, number>();
  layout.cells.forEach((c, i) => {
    for (const item of c.items) byItem.set(`${c.collectionId}#${item}`, i);
  });
  const held: CollectibleEntry[][] = layout.cells.map(() => []);
  const creditsByCell: CollectibleEntry[][] = layout.cells.map(() => []);
  for (const e of entries) {
    const i = cellOf(layout, byItem, e);
    if (i !== undefined) (e.pending ? creditsByCell : held)[i]!.push(e);
  }

  return layout.cells.map((_, i) => {
    const copies = held[i]!;
    const credits = creditsByCell[i]!;
    if (copies.length === 0 && credits.length === 0) return MISSING;
    copies.sort((a, b) => (when(b) ?? 0) - (when(a) ?? 0));
    credits.sort((a, b) => (when(b) ?? 0) - (when(a) ?? 0));
    const shown = copies[0] ?? credits[0]!;
    // A credit counts as found from its award, as if its NFT were minted.
    const times = [...copies, ...credits].map(when).filter((t): t is number => typeof t === 'number');
    const r = shown.resolved;
    return {
      status: copies.length > 0 ? 'owned' : 'credit',
      copies: copies.length,
      entries: copies,
      ...(times.length ? { foundAt: Math.min(...times) } : {}),
      isNew: copies.some((e) => isNewAt(e, now)) || credits.some((e) => isNewAt(e, now)),
      newCopies: copies.filter((e) => unseen.has(e.hash)).length,
      credits,
      look: {
        name: r.name,
        ...(r.hasArt !== false ? { imageUrl: r.url } : {}),
        ...(r.artPending ? { artPending: true } : {}),
        entry: shown,
      },
    };
  });
}
