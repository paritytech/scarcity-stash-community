// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// Paging from a piece's page: the order the grid draws the player's pieces
// in, collection by collection and tier by tier, and the words that place a
// piece in its tier. Pure, so the order is tested without a DOM.

import type { FieldLayout } from './field';

/** Every piece `shown` marks as the player's, in the grid's order; with
 *  `within`, only those, in its order. */
export function pageList(
  layout: Pick<FieldLayout, 'areas' | 'regions'>,
  shown: (i: number) => boolean,
  within?: readonly number[],
): number[] {
  if (within) return within.filter(shown);
  const list: number[] = [];
  for (const r of layout.regions)
    for (const ai of r.areas) {
      const a = layout.areas[ai];
      if (!a) continue;
      for (let k = a.from; k < a.to; k++) if (shown(k)) list.push(k);
    }
  return list;
}

/** Index `idx` brought round into a list of `n`: one past the last is the
 *  first, one before the first is the last. */
export const wrapIndex = (idx: number, n: number): number => (n > 0 ? ((idx % n) + n) % n : 0);

/** Where piece i stands among the player's pieces in its tier: "2 of 6 Rare in
 *  Sports", or "Rare in Sports" when it is the only one. */
export function tierPlace(
  layout: Pick<FieldLayout, 'areas' | 'regions' | 'areaOf'>,
  shown: (i: number) => boolean,
  i: number,
): string {
  const a = layout.areas[layout.areaOf[i] ?? -1];
  const r = a ? layout.regions[a.region] : undefined;
  if (!a || !r) return '';
  const tiered = r.areas.length > 1;
  let n = 0;
  let at = 0;
  for (let k = a.from; k < a.to; k++)
    if (shown(k)) {
      n++;
      if (k === i) at = n;
    }
  if (n > 1) return `${String(at)} of ${String(n)} ${tiered ? `${a.name} in ` : 'in '}${r.name}`;
  return tiered ? `${a.name} in ${r.name}` : r.name;
}
