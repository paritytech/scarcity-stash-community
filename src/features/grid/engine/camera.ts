// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// The camera: where the grid is looked at from. Its width never moves, its
// scale is the piece size of the step the grid is on (engine/grid.ts), and its
// y is the scroll. Scrolls, and moves between steps that keep a piece where it
// is; what happens past the grid's ends is engine/edges.ts.

import { restingStep } from '../model/grid';
import { BOTI, cam, els, F, flags, grid, kick, motion, type Task, tasks, TOPI, view } from './core';
import { settleEdges } from './edges';
import { type Anchor, anchorAt, placeGrid, restStep, saveStep, stepCount } from './grid';
import { haptic } from './haptic';
import { closeLoupe, lensState } from './lens';
import { clamp, ease, easeOut, lerp } from './util';

export const camState = {
  task: null as Task | null,
  done: null as ((cut: boolean) => void) | null,
  lastMove: 0,
  /** A fling: the scroll it started from, px, its speed then, px a second,
   *  and when, ms (engine/edges.ts). */
  mom: null as { x0: number; v0: number; t0: number } | null,
};

/** The camera y that puts the middle of rows y0 to y1 between the header and the dock. */
const centerFor = (y0: number, y1: number, s: number): number => (y0 + y1) / 2 + (BOTI - TOPI) / 2 / s;

/** Where the camera may rest: from the top of the grid to its end. */
export function camBounds(): { y0: number; y1: number } {
  const s = cam.s;
  const y0 = view.H / 2 / s;
  return { y0, y1: Math.max(y0, (grid.height - view.H / 2) / s) };
}

/** The camera y that shows piece i: its row in the middle of the view, as far
 *  as the grid goes. */
export function framePiece(i: number): number {
  const y = F.layout.py[i]!;
  const b = camBounds();
  return clamp(centerFor(y, y, cam.s), b.y0, b.y1);
}

export function camMoved(): void {
  flags.dirty = true;
  camState.lastMove = performance.now();
  kick();
}

/** Stop any scroll, step or momentum. A move's callback still runs, with cut
 *  = true, so whatever waits on it can carry on. */
export function stopCam(): void {
  camState.mom = null;
  if (camState.task) {
    els.field.style.opacity = '';
    tasks.delete(camState.task);
    camState.task = null;
    const d = camState.done;
    camState.done = null;
    if (d) d(true);
  }
}

function run(task: Task, done: ((cut: boolean) => void) | null): void {
  camState.done = done;
  camState.task = task;
  tasks.add(task);
  kick();
}

function finish(): void {
  camState.task = null;
  const cb = camState.done;
  camState.done = null;
  if (cb) cb(false);
}

/** Scroll to world height `ty`, within the grid. Under reduced motion the
 *  field dips and cuts. */
export function scrollTo(ty: number, dur = 0, done: ((cut: boolean) => void) | null = null, curve?: 'out'): void {
  stopCam();
  if (lensState.sticky && !lensState.auto) closeLoupe();
  const b = camBounds();
  ty = clamp(ty, b.y0, b.y1);
  const y0 = cam.y;
  const t0 = performance.now();
  const RM = motion.reduced;
  const d = RM ? 160 : dur || clamp(320 + Math.abs(ty - y0) * cam.s * 0.25, 360, 700);
  const ez = curve === 'out' ? easeOut : ease;
  run((now) => {
    const p = clamp((now - t0) / d, 0, 1);
    const e = RM ? (p < 0.5 ? 0 : 1) : ez(p);
    if (RM) els.field.style.opacity = p >= 1 ? '' : (0.15 + 0.85 * Math.abs(1 - 2 * p)).toFixed(3);
    cam.y = lerp(y0, ty, e);
    camMoved();
    if (p < 1) return true;
    finish();
    return false;
  }, done);
}

/** Scroll so rows y0 to y1 show: whole and centred when they fit between the
 *  header and the dock, else from the top. */
export function fitRows(y0: number, y1: number, done: ((cut: boolean) => void) | null = null): void {
  const s = cam.s;
  const fits = (y1 - y0) * s <= view.H - TOPI - BOTI - 16;
  scrollTo(fits ? centerFor(y0, y1, s) : y0 + (view.H / 2 - TOPI - 8) / s, 0, done);
}

/** Move to step `target`, the anchor (else the middle of the view) staying
 *  at its screen height. An overscroll a pinch left eases out on the way. */
export function zoomTo(target: number, an: Anchor | null, dur = 0, done: ((cut: boolean) => void) | null = null): void {
  stopCam();
  const n = stepCount();
  if (!n) return;
  target = clamp(target, 0, n - 1);
  const anchor = an ?? anchorAt(view.W / 2, view.H / 2);
  const z0 = grid.z;
  const from = restStep();
  const b0 = camBounds();
  const over = (cam.y - clamp(cam.y, b0.y0, b0.y1)) * cam.s;
  // A pull past the ends eases back to nothing on the way.
  const pull0 = grid.over;
  const t0 = performance.now();
  const d = motion.reduced ? 1 : dur || 340;
  run((now) => {
    const p = clamp((now - t0) / d, 0, 1);
    const e = easeOut(p);
    grid.z = p < 1 ? lerp(z0, target, e) : target;
    grid.over = p < 1 ? pull0 * (1 - e) : 0;
    placeGrid(anchor);
    const b = camBounds();
    cam.y = clamp(cam.y, b.y0, b.y1) + (over * (1 - e)) / cam.s;
    camMoved();
    if (p < 1) return true;
    if (target !== from) haptic('tick');
    saveStep();
    finish();
    return false;
  }, done);
}

/** One step in or out around screen point (px, py). */
export function zoomStep(px: number, py: number, dir: 1 | -1): void {
  const cur = restStep();
  const next = clamp(cur + dir, 0, stepCount() - 1);
  if (next === cur && grid.z === cur) return;
  if (lensState.on) closeLoupe('now');
  zoomTo(next, anchorAt(px, py), 380);
}

/** The step that shows the whole grid at once: the closest one the grid fits
 *  the view at, else the dots. */
function fitStep(): number {
  for (let z = stepCount() - 1; z > 0; z--) if ((grid.layouts[z]?.height ?? Infinity) <= view.H) return z;
  return 0;
}

/** The whole grid in view, from the top. */
export function fitAll(instant = false, done: ((cut: boolean) => void) | null = null): void {
  const z = fitStep();
  if (instant) {
    stopCam();
    grid.z = z;
    grid.over = 0;
    placeGrid(null);
    cam.y = camBounds().y0;
    camMoved();
    done?.(false);
    return;
  }
  zoomTo(z, null, 0, (cut) => {
    if (cut) done?.(true);
    else scrollTo(camBounds().y0, 0, done);
  });
}

/** Whether the grid stands off a step, or pulled past a zoom limit. */
export const isBetweenSteps = (): boolean => Math.abs(grid.z - restingStep(grid.z)) > 1e-3 || grid.over !== 0;

/** Settles the grid after an overshoot: on the nearer step, back inside a zoom
 *  limit, or at its top or bottom (engine/edges.ts). */
export function settleBounds(): void {
  if (isBetweenSteps()) zoomTo(restingStep(grid.z), null, 300);
  else settleEdges();
}
