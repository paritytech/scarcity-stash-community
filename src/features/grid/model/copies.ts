// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// The pages a square opens on in the sheet: its own page for what the player
// holds there, then one page per credit standing on it.

import type { CollectibleEntry } from '@/entities/nfts/format';

import { isNewAt, type PieceState } from './field';

export type CopyPage = { kind: 'own' } | { kind: 'credit'; entry: CollectibleEntry };

/** Square `p`'s pages in order: its own page unless only credits stand there,
 *  then each credit, newest first, as the overlay sorts them. */
export function copyPages(p: PieceState): CopyPage[] {
  const pages: CopyPage[] = p.status === 'credit' ? [] : [{ kind: 'own' }];
  for (const entry of p.credits) pages.push({ kind: 'credit', entry });
  return pages;
}

/** The page the sheet opens on: while New is showing, the first page with
 *  something that arrived in the last 12 hours; otherwise the first page. */
export function startPage(p: PieceState, pages: readonly CopyPage[], now: number, fromNew: boolean): number {
  if (!fromNew) return 0;
  const k = pages.findIndex((g) => (g.kind === 'own' ? p.entries.some((e) => isNewAt(e, now)) : isNewAt(g.entry, now)));
  return Math.max(0, k);
}

/** The page of the credit with `hashHex`, or -1 when no credit here has it. */
export const pageOf = (pages: readonly CopyPage[], hashHex: string): number =>
  pages.findIndex((g) => g.kind === 'credit' && g.entry.hashHex === hashHex);
