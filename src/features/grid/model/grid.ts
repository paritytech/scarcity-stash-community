// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// The collection as a grid of fixed width: one column of cards, a collection
// each, with its tiers inside, laid out once for every zoom step.
// The engine blends the two steps either side of a pinch, so a step is pure
// geometry: where each piece, title and label sits, in pixels from the top of
// the content. Pure, so the steps are tested without a DOM.

import type { FieldLayout } from './field';

export interface GridStep {
  /** Pieces across a phone. A wider screen fits more at the same size. */
  cols: number;
  gap: number;
  /** A collection's title row and title size. */
  head: number;
  headSize: number;
  /** A tier's label row and label size. */
  tier: number;
  tierSize: number;
  /** Space after a collection, and between two tiers. */
  sectionGap: number;
  tierGap: number;
  /** Every piece a dot, the found ones in their colour. */
  dots?: boolean;
  /** A name under each piece. */
  names?: boolean;
  /** The pieces not found gather into one line per collection that counts them. */
  fold?: boolean;
}

/** From every piece as a small dot to three to a row with their names. */
export const STEPS: readonly GridStep[] = [
  { cols: 21, gap: 3, head: 26, headSize: 14, tier: 20, tierSize: 11, sectionGap: 6, tierGap: 3, dots: true },
  { cols: 13, gap: 4, head: 28, headSize: 15, tier: 22, tierSize: 11, sectionGap: 8, tierGap: 4, dots: true },
  { cols: 8, gap: 5, head: 34, headSize: 16, tier: 22, tierSize: 12, sectionGap: 12, tierGap: 6 },
  { cols: 5, gap: 6, head: 38, headSize: 17, tier: 24, tierSize: 12, sectionGap: 14, tierGap: 8 },
  {
    cols: 3,
    gap: 10,
    head: 40,
    headSize: 18,
    tier: 24,
    tierSize: 13,
    sectionGap: 18,
    tierGap: 10,
    names: true,
    fold: true,
  },
];

/** Five across: the step a first visit opens on. */
export const DEFAULT_STEP = 3;
/** Three across: the closest step. */
export const LAST_STEP = STEPS.length - 1;

/** The step a value saved on the device names, or the default step when it names none. */
export function savedStepOf(v: unknown): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? Math.min(v, LAST_STEP) : DEFAULT_STEP;
}

/** A pinch still moving faster than this many steps a second when the
 *  fingers lift carries on to the next step. */
const FLING_STEPS = 1.4;

/** The step a grid left at `z` settles on: the nearest, or the next one when a
 *  pinch still moved at `pace` steps a second; past an end, that end. */
export function restingStep(z: number, pace = 0): number {
  let target = Math.round(z);
  if (Math.abs(pace) > FLING_STEPS) target = pace > 0 ? Math.ceil(z) : Math.floor(z);
  return Math.min(LAST_STEP, Math.max(0, target));
}

/** The two steps a grid at `z` blends: the lower one and how far towards the
 *  next, 0 to 1, never past the ends. */
export function stepBlend(z: number, n: number): { a: number; k: number } {
  if (n < 2) return { a: 0, k: 0 };
  const a = Math.min(n - 2, Math.max(0, Math.floor(z)));
  return { a, k: Math.min(1, Math.max(0, z - a)) };
}

/** How far a pinch pulls past the ends, from -1 (far) to 1 (close), for a piece
 *  `t` wide; doubling the size past an end pulls all the way. 0 inside. */
export function overOf(t: number, far: number, close: number): number {
  if (t < far) return Math.max(-1, -Math.log2(far / t));
  if (t > close) return Math.min(1, Math.log2(t / close));
  return 0;
}

/** How much the whole frame scales past an end at most, so a limit reads as one. */
export const GIVE = 0.04;
export const giveScale = (over: number): number => 1 + GIVE * Math.min(1, Math.max(-1, over));

/** How big a piece draws on a cell `s` wide: never past its cell, and a
 *  little inside it when big, since the pictures carry their own margin. */
export const pieceSize = (s: number): number => s * Math.max(0.98, Math.min(1, 1.36 - (s - 24) * 0.012));

/** How strongly a piece draws, and its name with it. */
export interface Ink {
  piece: number;
  name: number;
}

/** A piece the filter leaves out fades almost away, and its name draws as
 *  strongly, as far as names are in (0 to 1). */
export function inkOf(out: boolean, names: number): Ink {
  const a = out ? 0.08 : 1;
  return { piece: a, name: a * names };
}

/** The line under a collection's pieces for the ones still to find. */
export const leftLine = (n: number): string => `${String(n)} more to collect`;

/** The side gutter, a collection card's inner margin, and the width the
 *  steps are drawn for. */
export const GUTTER = 12;
export const CARD_PAD = 12;
const PHONE_INNER = 390 - 2 * GUTTER - 2 * CARD_PAD;
/** The lens shows a piece at least as big as six across the phone would. */
const LENS_ACROSS = 6;
const LENS_GAP = 6;
/** A name under a piece. */
const NAME_ROW = 22;
/** The cell a piece still to find keeps at a folding step, gathered with the
 *  others where the line that counts them starts. */
const DOT = 10;
/** That line: its gap under the collection's last pieces, its row and its
 *  baseline. */
const LEFT_GAP = 8;
const LEFT_ROW = 22;
const LEFT_BASE = 15;

/** A collection's card. Every card spans the width inside the gutters. */
export interface GridSection {
  y: number;
  h: number;
  /** The title's baseline and size. */
  titleY: number;
  size: number;
  /** At a folding step, how many of the collection's pieces are still to find
   *  and where that line sits; elsewhere 0 and the foot of the last tier. */
  left: number;
  leftY: number;
}

export interface GridTier {
  y: number;
  h: number;
  /** The label's baseline and size. */
  labelY: number;
  size: number;
  /** 1 where the label shows: in a collection with more than one tier. */
  shown: number;
}

export interface GridLayout {
  width: number;
  height: number;
  /** Where the pieces start, the width they span, and a piece's size. */
  x0: number;
  inner: number;
  pieceSide: number;
  /** Per cell: x, y, w and h. */
  rects: Float32Array;
  /** Per region, then per area of the field layout. */
  sections: GridSection[];
  tiers: GridTier[];
  /** 1 where every piece is a dot, where names show under the pieces, and
   *  where the pieces still to find are counted in words instead of drawn. */
  dots: number;
  names: number;
  words: number;
  fold: boolean;
}

/** Columns and piece size for `cols` across a phone, or more at that size on a
 *  wider screen. */
function across(cols: number, gap: number, inner: number): { cols: number; pieceSide: number } {
  const phonePieceSide = (PHONE_INNER - (cols - 1) * gap) / cols;
  const n = Math.max(cols, Math.round((inner + gap) / (phonePieceSide + gap)));
  return { cols: n, pieceSide: (inner - (n - 1) * gap) / n };
}

const columns = (step: GridStep, inner: number): { cols: number; pieceSide: number } =>
  across(step.cols, step.gap, inner);

/** The least size the lens shows a piece at: its size at six across, whatever
 *  the step. */
export const lensPieceSide = (width: number): number =>
  across(LENS_ACROSS, LENS_GAP, Math.max(1, width - 2 * GUTTER - 2 * CARD_PAD)).pieceSide;

/** Lays out every cell for one step at `width`; at a folding step the pieces
 *  not `found` are counted once per collection under its last tier. */
export function layoutGrid(
  layout: Pick<FieldLayout, 'cells' | 'areas' | 'regions'>,
  found: (i: number) => boolean,
  step: GridStep,
  width: number,
  top: number,
  bottom: number,
): GridLayout {
  const inner = Math.max(1, width - 2 * GUTTER - 2 * CARD_PAD);
  const { cols, pieceSide } = columns(step, inner);
  const span = cols * pieceSide + (cols - 1) * step.gap;
  const x0 = GUTTER + CARD_PAD + (inner - span) / 2;
  const rowH = (step.names ? pieceSide + NAME_ROW : pieceSide) + step.gap;
  const rects = new Float32Array(layout.cells.length * 4);
  const put = (i: number, x: number, y: number, w: number): void => {
    rects[i * 4] = x;
    rects[i * 4 + 1] = y;
    rects[i * 4 + 2] = w;
    rects[i * 4 + 3] = w;
  };
  const sections: GridSection[] = [];
  const tiers: GridTier[] = layout.areas.map(() => ({ y: 0, h: 0, labelY: 0, size: step.tierSize, shown: 0 }));
  let y = top;
  layout.regions.forEach((r, ri) => {
    if (ri) y += step.sectionGap;
    const sy = y;
    y += CARD_PAD;
    const section: GridSection = { y: sy, h: 0, titleY: y + step.head * 0.72, size: step.headSize, left: 0, leftY: 0 };
    sections.push(section);
    y += step.head;
    const multi = r.areas.length > 1;
    const rest: number[] = [];
    r.areas.forEach((ai, k) => {
      const a = layout.areas[ai];
      if (!a) return;
      if (k) y += step.tierGap;
      const tier = tiers[ai]!;
      tier.y = y;
      // The label sits high in its row: a small piece draws a little above its cell.
      tier.labelY = y + step.tier * 0.66;
      tier.shown = multi ? 1 : 0;
      if (multi) y += step.tier;
      let n = 0;
      for (let i = a.from; i < a.to; i++) {
        if (step.fold && !found(i)) {
          rest.push(i);
          continue;
        }
        put(i, x0 + (n % cols) * (pieceSide + step.gap), y + Math.floor(n / cols) * rowH, pieceSide);
        n++;
      }
      if (n) y += Math.ceil(n / cols) * rowH - step.gap;
      tier.h = y - tier.y;
    });
    section.leftY = y;
    // At a folding step the collection's pieces still to find are one line
    // of words under its last tier. Their cells gather where it starts, so
    // whatever looks a piece up by its cell still finds one.
    if (rest.length) {
      y += LEFT_GAP;
      section.left = rest.length;
      section.leftY = y + LEFT_BASE;
      for (const i of rest) put(i, x0, y + (LEFT_ROW - DOT) / 2, DOT);
      y += LEFT_ROW;
    }
    y += CARD_PAD;
    section.h = y - sy;
  });
  return {
    width,
    height: y + bottom,
    x0,
    inner: span,
    pieceSide,
    rects,
    sections,
    tiers,
    dots: step.dots ? 1 : 0,
    names: step.names ? 1 : 0,
    words: step.fold ? 1 : 0,
    fold: step.fold === true,
  };
}
