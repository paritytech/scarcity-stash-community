// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// Search on the grid: names only for pieces the player found, plus the
// collections and tiers by name. A missing piece's name is never searchable.

import type { FieldLayout, PieceState } from './field';

interface PlaceHit {
  region: number;
  /** Set for a tier inside a collection with several. */
  area?: number;
}

export interface SearchHits {
  places: PlaceHit[];
  pieces: number[];
}

const found = (p: PieceState): boolean => p.status !== 'missing' && p.look !== undefined;

/** Found pieces, newest find first. */
function recentFinds(pieces: readonly PieceState[], limit: number): number[] {
  const owned: number[] = [];
  pieces.forEach((p, i) => {
    if (found(p)) owned.push(i);
  });
  owned.sort((a, b) => (pieces[b]!.foundAt ?? 0) - (pieces[a]!.foundAt ?? 0));
  return owned.slice(0, limit);
}

/** Matches for `query`: names that start with it first, then ones that
 *  contain it, each alphabetical. An empty query finds the five newest. */
export function searchField(query: string, layout: FieldLayout, pieces: readonly PieceState[]): SearchHits {
  const q = query.trim().toLowerCase();
  if (!q) return { places: [], pieces: recentFinds(pieces, 5) };
  const hits: { i: number; rank: number; name: string }[] = [];
  pieces.forEach((p, i) => {
    if (!found(p) || !p.look) return;
    const name = p.look.name;
    const at = name.toLowerCase().indexOf(q);
    if (at >= 0) hits.push({ i, rank: at === 0 ? 0 : 1, name });
  });
  hits.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  const places: PlaceHit[] = [];
  for (const r of layout.regions) {
    if (r.name.toLowerCase().includes(q)) places.push({ region: r.idx });
    if (r.areas.length > 1)
      for (const a of r.areas)
        if (layout.areas[a]!.name.toLowerCase().includes(q)) places.push({ region: r.idx, area: a });
  }
  return { places, pieces: hits.map((h) => h.i) };
}
