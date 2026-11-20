// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// Where the grid is. The step layouts (model/grid.ts) are blended at the step
// z, a fraction while a pinch or a step moves it, and written into the field
// layout's world positions in units of the blended piece size. The camera is
// set so a world point lands on its content pixel, so everything that places
// something on screen keeps going through it: its y is the scroll and its
// scale follows the step.

import { deviceStore } from '@/shared/lib/deviceStore';

import { GUTTER, layoutGrid, overOf, savedStepOf, stepBlend, STEPS } from '../model/grid';
import { BOTI, cam, F, grid, TOPI, view } from './core';
import { clamp, lerp } from './util';

/** What stays under the fingers while the step changes, held by key so it
 *  outlives a new field: a piece, else a place in a collection or the grid. */
export interface Anchor {
  key?: string;
  region?: string;
  f: number;
  sy: number;
}

/** A piece stands as a picture in the layout from the moment it is the
 *  player's, before its arrival lands, so an arriving piece never moves. */
const standing = (i: number): boolean => {
  const st = F.pieces[i]?.status;
  return st === 'owned' || st === 'credit';
};

export const stepCount = (): number => grid.layouts.length;
/** The step the grid rests on, or the nearest one while it moves. */
export const restStep = (): number => clamp(Math.round(grid.z), 0, Math.max(0, grid.layouts.length - 1));
/** At the step where the missing pieces are counted in words, there is
 *  nothing of them to look at through the lens. */
export const folded = (): boolean => grid.layouts[restStep()]?.fold === true;
const scrollOf = (): number => cam.y * cam.s - view.H / 2;
/** How wide cell i is drawn at the current blend: a piece's cell, or a
 *  folded dot's. */
export const cellSize = (i: number): number => grid.rects[i * 4 + 2] ?? cam.s;

/** The step this device last rested on. */
export function savedStep(): number {
  return savedStepOf(deviceStore.getState().gridStep);
}

export function saveStep(): void {
  const gridStep = restStep();
  if (gridStep !== deviceStore.getState().gridStep) deviceStore.setState({ gridStep });
}

/** Lay every step out again, for a new field, new pieces or a new width; the
 *  anchor keeps what was in view where it was. */
export function rebuildGrid(an: Anchor | null): void {
  grid.layouts = STEPS.map((step) => layoutGrid(F.layout, standing, step, view.W, TOPI, BOTI + 24));
  grid.z = clamp(grid.z, 0, grid.layouts.length - 1);
  placeGrid(an);
}

/** Blends the steps at grid.z into world positions and sets the camera,
 *  keeping `an` at its screen height when given. */
export function placeGrid(an: Anchor | null): void {
  const n = grid.layouts.length;
  if (!n) return;
  const before = scrollOf();
  const { a, k } = stepBlend(grid.z, n);
  const A = grid.layouts[a]!;
  const B = grid.layouts[Math.min(a + 1, n - 1)]!;
  if (grid.rects.length !== A.rects.length) grid.rects = new Float32Array(A.rects.length);
  for (let j = 0; j < A.rects.length; j++) grid.rects[j] = lerp(A.rects[j]!, B.rects[j]!, k);
  grid.sections = A.sections.map((sa, j) => {
    const sb = B.sections[j]!;
    return {
      y: lerp(sa.y, sb.y, k),
      h: lerp(sa.h, sb.h, k),
      titleY: lerp(sa.titleY, sb.titleY, k),
      size: lerp(sa.size, sb.size, k),
      left: Math.max(sa.left, sb.left),
      leftY: lerp(sa.leftY, sb.leftY, k),
    };
  });
  grid.tiers = A.tiers.map((ta, j) => {
    const tb = B.tiers[j]!;
    return {
      y: lerp(ta.y, tb.y, k),
      h: lerp(ta.h, tb.h, k),
      labelY: lerp(ta.labelY, tb.labelY, k),
      size: lerp(ta.size, tb.size, k),
      shown: lerp(ta.shown, tb.shown, k),
    };
  });
  grid.height = lerp(A.height, B.height, k);
  grid.dots = clamp(lerp(A.dots, B.dots, k), 0, 1);
  grid.names = clamp(lerp(A.names, B.names, k), 0, 1);
  grid.words = clamp(lerp(A.words, B.words, k), 0, 1);

  const s = Math.max(1, lerp(A.pieceSide, B.pieceSide, k));
  const L = F.layout;
  const r = grid.rects;
  for (let i = 0; i < L.cells.length; i++) {
    const o = i * 4;
    L.px[i] = (r[o]! + r[o + 2]! / 2) / s;
    L.py[i] = (r[o + 1]! + r[o + 3]! / 2) / s;
  }
  const left = GUTTER / s;
  const width = (view.W - 2 * GUTTER) / s;
  for (const area of L.areas) {
    const t = grid.tiers[area.idx];
    if (!t) continue;
    area.x = left;
    area.w = width;
    area.y = t.y / s;
    area.h = t.h / s;
  }
  for (const region of L.regions) {
    const sec = grid.sections[region.idx];
    if (!sec) continue;
    region.y = sec.y / s;
    region.h = sec.h / s;
  }
  const scroll = an ? anchorContent(an) - an.sy : before;
  cam.s = s;
  cam.y = (scroll + view.H / 2) / s;
}

/** The anchor under screen point (x, y). */
export function anchorAt(x: number, y: number): Anchor {
  const cy = y + scrollOf();
  const L = F.layout;
  const r = grid.rects;
  let best = -1;
  let bd = Infinity;
  for (let i = 0; i < L.cells.length; i++) {
    const o = i * 4;
    const dx = r[o]! + r[o + 2]! / 2 - x;
    const dy = r[o + 1]! + r[o + 3]! / 2 - cy;
    const d = dx * dx + dy * dy;
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  if (best >= 0 && Math.sqrt(bd) < Math.max(r[best * 4 + 2]!, 24) * 1.6) {
    const o = best * 4;
    return { key: L.cells[best]!.key, f: (cy - r[o + 1]!) / Math.max(1, r[o + 3]!), sy: y };
  }
  for (const region of L.regions) {
    const sec = grid.sections[region.idx];
    if (sec && cy >= sec.y && cy < sec.y + sec.h) return { region: region.id, f: (cy - sec.y) / sec.h, sy: y };
  }
  return { f: grid.height > 0 ? cy / grid.height : 0, sy: y };
}

/** Where the anchor is now, in content pixels. */
function anchorContent(an: Anchor): number {
  const L = F.layout;
  if (an.key !== undefined) {
    const i = L.index.get(an.key);
    if (i !== undefined) return grid.rects[i * 4 + 1]! + an.f * grid.rects[i * 4 + 3]!;
  }
  if (an.region !== undefined) {
    const region = L.regions.find((x) => x.id === an.region);
    const sec = region ? grid.sections[region.idx] : undefined;
    if (sec) return sec.y + an.f * sec.h;
  }
  return an.f * grid.height;
}

/** The piece size at step z, moving in proportion between the steps. */
export function pieceSideAt(z: number): number {
  const n = grid.layouts.length;
  if (n < 2) return grid.layouts[0]?.pieceSide ?? cam.s;
  const a = clamp(Math.floor(z), 0, n - 2);
  const ta = Math.log(grid.layouts[a]!.pieceSide);
  const tb = Math.log(grid.layouts[a + 1]!.pieceSide);
  return Math.exp(lerp(ta, tb, z - a));
}

/** The step at which pieces are `t` wide, held at either end: past them the
 *  grid gives a little instead (overFromPieceSide). */
export function zFromPieceSide(t: number): number {
  const n = grid.layouts.length;
  if (n < 2) return 0;
  const lt = Math.log(t);
  const l = (i: number): number => Math.log(grid.layouts[i]!.pieceSide);
  if (lt <= l(0)) return 0;
  for (let a = 0; a < n - 1; a++) if (lt <= l(a + 1)) return a + (lt - l(a)) / (l(a + 1) - l(a));
  return n - 1;
}

/** How far past the ends a pinch to pieces `t` wide pulls, -1 to 1
 *  (model/grid.ts). */
export function overFromPieceSide(t: number): number {
  const n = grid.layouts.length;
  if (n < 1) return 0;
  return overOf(t, grid.layouts[0]!.pieceSide, grid.layouts[n - 1]!.pieceSide);
}
