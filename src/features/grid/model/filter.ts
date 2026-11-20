// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// The grid's filter: which pieces match, and how the filter names itself.
// Dates are days since the player's first find, so the chart's range runs from
// that day (0) to today (`span.last`).

import { dateOfDay, dayDate, dayNumber, shortDate, today } from './days';
import type { FieldLayout, PieceState } from './field';

export interface Filter {
  show: 'all' | 'found' | 'missing';
  rare: boolean;
  isNew: boolean;
  /** Day range, in days since the first find; d1 past today means "to today". */
  d0: number;
  d1: number;
}

export const NO_FILTER: Filter = { show: 'all', rare: false, isNew: false, d0: 0, d1: 1e9 };

/** The player's history: the day of their first find, and how many days ago
 *  that was. `first` is null before anything is found. */
export interface Span {
  first: number | null;
  last: number;
}

export function spanOf(pieces: readonly PieceState[]): Span {
  let first: number | null = null;
  for (const p of pieces) {
    if (p.status === 'missing' || p.foundAt === undefined) continue;
    const d = dayNumber(p.foundAt);
    if (first === null || d < first) first = d;
  }
  return first === null ? { first: null, last: -1 } : { first, last: Math.max(0, today(Date.now()) - first) };
}

export const hasHistory = (span: Span): boolean => span.first !== null;

export const fullRange = (f: Filter, span: Span): boolean => f.d0 <= 0 && f.d1 >= span.last;

export const filterActive = (f: Filter, span: Span): boolean =>
  f.show !== 'all' || f.rare || f.isNew || !fullRange(f, span);

/** The piece's find day, in days since the first find. */
export const foundDay = (p: PieceState, span: Span): number | undefined =>
  p.foundAt === undefined || span.first === null ? undefined : dayNumber(p.foundAt) - span.first;

/** Whether cell `i` matches: Found is anything standing there, Rare your rare
 *  pieces (with Missing, those to find), New what arrived in the last 12 hours. */
function matchesPiece(f: Filter, span: Span, layout: FieldLayout, pieces: readonly PieceState[], i: number): boolean {
  const p = pieces[i];
  const cell = layout.cells[i];
  if (!p || !cell) return false;
  const found = p.status !== 'missing';
  if (f.show === 'found' && !found) return false;
  if (f.show === 'missing' && found) return false;
  if (f.rare && (!cell.rare || (f.show === 'all' && !found))) return false;
  if (f.isNew && !p.isNew) return false;
  if (!fullRange(f, span)) {
    if (!found) return false;
    const d = foundDay(p, span);
    if (d === undefined || d < f.d0 || d > f.d1) return false;
  }
  return true;
}

/** Every matching cell in layout order, or none when the filter is off. */
export function matchAll(f: Filter, span: Span, layout: FieldLayout, pieces: readonly PieceState[]): number[] {
  if (!filterActive(f, span)) return [];
  const out: number[] = [];
  for (let i = 0; i < layout.cells.length; i++) if (matchesPiece(f, span, layout, pieces, i)) out.push(i);
  return out;
}

/** Only New is on, the way the dock's New button sets it. */
export const onlyNew = (f: Filter, span: Span): boolean =>
  f.isNew && f.show === 'found' && !f.rare && fullRange(f, span);

/** How many criteria are on, for "Filter · 2". */
export const criteriaCount = (f: Filter, span: Span): number =>
  (f.show !== 'all' ? 1 : 0) + (f.rare ? 1 : 0) + (f.isNew ? 1 : 0) + (fullRange(f, span) ? 0 : 1);

/** "Today", "Fri, Oct 3", or "Oct 3 to today". */
export function rangeLabel(f: Filter, span: Span): string {
  if (span.first === null) return '';
  const a = Math.max(0, f.d0);
  const b = Math.min(span.last, f.d1);
  const at = (d: number): Date => dateOfDay(span.first! + d);
  if (a === b) return a === span.last ? 'Today' : dayDate(at(a));
  return `${shortDate(at(a))} to ${b === span.last ? 'today' : shortDate(at(b))}`;
}

/** The filter's name on the step bar: "Rare", "New", "Missing", "Oct 3 to today". */
export function filterLabel(f: Filter, span: Span): string {
  const parts: string[] = [];
  if (f.rare) parts.push('Rare');
  if (f.isNew) parts.push('New');
  if (!fullRange(f, span)) parts.push(rangeLabel(f, span));
  let s = parts.join(', ');
  if (f.show === 'found' && !f.isNew) s = s ? `${s}, found` : 'Found';
  if (f.show === 'missing') s = s ? `${s}, missing` : 'Missing';
  return s || 'Everything';
}
