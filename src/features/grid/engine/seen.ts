// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// Seeing, on the grid. A copy or credit is seen once it was in view at a
// readable size for a moment, opened on its page, or landed with an orb. The
// record is the device's (lib/deviceStore.ts), and the New dot stays lit
// while New holds something unseen (filters.ts).

import { readSeen, recordSeen } from '@/shared/lib/deviceStore';

import { filterActive } from '../model/filter';
import { pieceSize } from '../model/grid';
import { unseenNew, unseenPieces } from '../model/seen';
import { BOTI, F, filter, isShown, sx, sy, TOPI, view } from './core';
import { cellSize } from './grid';

/** How long a piece stays in view before it counts as seen, and how wide its
 *  picture has to draw for that. */
const SEEN_MS = 500;
const SEEN_PX = 36;

let seen = new Set<string>();
/** Pieces with something New and unseen, by index (refreshUnseen). */
let unseen = new Set<number>();
let changed: () => void = () => undefined;
/** The unseen pieces the last frame drew in view, waiting out SEEN_MS. */
let exposed: number[] = [];
let timer = 0;

const nowSec = (): number => Date.now() / 1000;

/** Loads the seen record and sets `onChange`, called on each change (the New button). */
export function attachSeen(onChange: () => void): void {
  seen = readSeen();
  changed = onChange;
  exposed = [];
}

export function detachSeen(): void {
  window.clearTimeout(timer);
  timer = 0;
  exposed = [];
}

/** Recount after the field changed. */
export function refreshUnseen(): void {
  unseen = unseenPieces(F.pieces, seen, nowSec());
}

export const isUnseen = (i: number): boolean => unseen.has(i);
export const unseenCount = (): number => unseen.size;

/** Piece i was seen: its page opened, an orb landed on it, or it stayed in view. */
export function markSeen(i: number): void {
  const p = F.pieces[i];
  if (!p) return;
  const hashes = unseenNew(p, seen, nowSec());
  if (hashes.length === 0) return;
  for (const h of hashes) seen.add(h);
  recordSeen(hashes);
  unseen.delete(i);
  changed();
}

/** Whether piece i counts as seen: a picture at least SEEN_PX wide, whole
 *  between the header and the dock, lit by the filter, not held back or open. */
export function inViewReadable(i: number): boolean {
  if (F.detailI === i || !isShown(i)) return false;
  if (filterActive(filter.f, F.span) && !filter.matchSet.has(i)) return false;
  const s = pieceSize(cellSize(i));
  if (s < SEEN_PX) return false;
  const x = sx(F.layout.px[i]!);
  const y = sy(F.layout.py[i]!);
  return x - s / 2 >= 0 && x + s / 2 <= view.W && y - s / 2 >= TOPI && y + s / 2 <= view.H - BOTI;
}

/** A frame begins: what it draws in view is noted again (render.ts). */
export function frameStart(): void {
  exposed = [];
}

/** The frame drew unseen piece i in view. It is seen once it has stayed so
 *  for SEEN_MS, checked on a clock of its own: a still grid draws no frames. */
export function exposedNow(i: number): void {
  exposed.push(i);
  if (!timer) timer = window.setTimeout(settle, SEEN_MS);
}

/** What seeing holds right now, for the dev console. */
export function debugSeen(): { unseen: number[]; exposed: number[]; timer: number; readable: (i: number) => boolean } {
  return { unseen: [...unseen], exposed: [...exposed], timer, readable: inViewReadable };
}

function settle(): void {
  timer = 0;
  const due = exposed.filter((i) => unseen.has(i) && inViewReadable(i));
  exposed = [];
  for (const i of due) markSeen(i);
}
