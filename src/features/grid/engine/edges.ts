// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// Scrolling the grid by touch: the drag, the fling when the finger lifts, and
// the grid's top and bottom. The fling follows model/fling.ts, iOS's own
// physics; a fling that catches one still running carries some of its speed.
// Past an end the camera stays at the end and the drag pulls a stretch
// instead (model/edge.ts), which render.ts draws; the stretch relaxes once
// let go, and a drag that catches it carries on from it.

import { pullOf, stretchAbsorbed, stretchOf, stretchPeak, stretchReleased } from '../model/edge';
import {
  carriedMomentum,
  coast,
  flingSpeed,
  releaseSpeed,
  type Sample,
  SAMPLES,
  STILL_LOSES_MS,
  stopSpeed,
  withCarried,
} from '../model/fling';
import { camMoved, camState } from './camera';
import { cam, flags, grid, kick, motion, view } from './core';
import { clamp } from './util';

type Side = 'top' | 'bottom';

type Anim = { kind: 'release'; s0: number; t: number } | { kind: 'absorb'; peak: number; t: number };

export const edge = {
  /** How far past an end the grid is pulled, px, and which end. */
  pull: 0,
  side: 'top' as Side,
  /** The stretch drawn now, from 0 to STRETCH_MAX. */
  stretch: 0,
  /** A stretch relaxing, or a fling's stretch, while the fingers are off. */
  anim: null as Anim | null,
  /** The finger's recent positions, for its speed when it lifts. */
  samples: [] as Sample[],
  /** The speed this touch caught from a running fling, and when the finger
   *  last moved, for whether it keeps it. */
  carried: 0,
  movedAt: 0,
  /** When the wheel last turned. */
  wheelAt: 0,
};

const scrollMax = (): number => Math.max(0, grid.height - view.H);
const scrollPx = (): number => cam.y * cam.s - view.H / 2;
const inside = (px: number): boolean => px >= -0.5 && px <= scrollMax() + 0.5;

function showScroll(px: number): void {
  cam.y = (px + view.H / 2) / cam.s;
  camMoved();
}

function setStretch(s: number): void {
  if (s === edge.stretch) return;
  edge.stretch = s;
  flags.dirty = true;
  kick();
}

/** The fling running at `at` ms: where it is and how fast it goes. */
function flingAt(mom: NonNullable<typeof camState.mom>, at: number): { x: number; v: number } {
  return coast(mom.x0, mom.v0, Math.max(0, at - mom.t0) / 1000);
}

/** Resets the edges: nothing pulled or stretched, no animation running. */
export function resetEdges(): void {
  edge.pull = 0;
  edge.stretch = 0;
  edge.anim = null;
  edge.samples = [];
  edge.carried = 0;
}

/** A finger touched down at `y` px, at `t` ms: a running fling stops, and what
 *  it would carry into a new one is kept. */
export function touchDown(y: number, t: number): void {
  const mom = camState.mom;
  edge.carried = mom ? carriedMomentum(flingAt(mom, t).v) : 0;
  edge.samples = [{ t, y }];
  edge.movedAt = t;
}

/** The finger is at `y` px at `t` ms. Held still too long, it loses the
 *  momentum it caught. */
export function touchMove(y: number, t: number): void {
  const last = edge.samples[edge.samples.length - 1];
  if (last?.y !== y) edge.movedAt = t;
  else if (t - edge.movedAt > STILL_LOSES_MS) edge.carried = 0;
  edge.samples.push({ t, y });
  if (edge.samples.length > SAMPLES) edge.samples.shift();
}

/** A drag starts to scroll, catching a stretch that is still relaxing. */
export function dragStart(): void {
  edge.anim = null;
  edge.pull = pullOf(edge.stretch, view.H);
}

/** The finger moved `dy` px down: the grid follows it. */
export function dragBy(dy: number): void {
  scrollBy(-dy);
}

/** Scroll by `d` px with the camera held inside the ends: what runs past an
 *  end pulls the stretch, and a pull is undone before the grid scrolls back. */
function scrollBy(d: number): void {
  const max = scrollMax();
  const from = edge.pull > 0 ? (edge.side === 'top' ? -edge.pull : max + edge.pull) : clamp(scrollPx(), 0, max);
  const raw = from + d;
  showScroll(clamp(raw, 0, max));
  edge.pull = raw < 0 ? -raw : raw > max ? raw - max : 0;
  if (edge.pull > 0) edge.side = raw < 0 ? 'top' : 'bottom';
  setStretch(stretchOf(edge.pull, view.H));
}

/** The finger lifted at `t` ms after a drag: the stretch relaxes or the grid
 *  flings on. False when nothing started, so the caller settles. */
export function dragEnd(t: number): boolean {
  const carried = edge.carried;
  edge.carried = 0;
  if (edge.pull > 0) {
    letGo();
    return true;
  }
  // The grid scrolls the other way from the finger.
  const v = withCarried(-flingSpeed(releaseSpeed(edge.samples, t)), carried);
  if (v === 0 || motion.reduced) return false;
  camState.mom = { x0: scrollPx(), v0: v, t0: t };
  kick();
  return true;
}

/** The wheel turned `dy` px; once it stops, the stretch relaxes
 *  (settleEdges). */
export function wheelBy(dy: number, now: number): void {
  if (now - edge.wheelAt > 200) edge.pull = pullOf(edge.stretch, view.H);
  edge.wheelAt = now;
  edge.anim = null;
  scrollBy(dy);
}

/** A pinch moved the grid under the fingers past an end: it holds at the
 *  end. The caller updates the camera. */
export function holdEnds(): void {
  const shown = scrollPx();
  if (inside(shown)) return;
  cam.y = (clamp(shown, 0, scrollMax()) + view.H / 2) / cam.s;
}

/** Back inside the ends: the stretch relaxes, and a camera left past an end
 *  returns to it. */
export function settleEdges(): void {
  if (edge.stretch > 0 && !edge.anim) letGo();
  const shown = scrollPx();
  if (!inside(shown)) showScroll(clamp(shown, 0, scrollMax()));
}

function letGo(): void {
  edge.pull = 0;
  if (motion.reduced) {
    setStretch(0);
    return;
  }
  edge.anim = { kind: 'release', s0: edge.stretch, t: 0 };
  kick();
}

/** One frame of the fling and the stretch, timed from the fling's start so a
 *  late frame never shortens it. True while something moves. */
export function stepEdges(now: number, dt: number): boolean {
  const mom = camState.mom;
  const anim = edge.anim;
  if (mom) {
    const { x, v } = flingAt(mom, now);
    const max = scrollMax();
    if (x < 0 || x > max) {
      // The fling meets an end: it stops there and stretches the grid briefly.
      const side: Side = x < 0 ? 'top' : 'bottom';
      showScroll(side === 'top' ? 0 : max);
      camState.mom = null;
      if (!motion.reduced) {
        edge.side = side;
        edge.anim = { kind: 'absorb', peak: stretchPeak(v), t: 0 };
        kick();
      }
    } else {
      showScroll(x);
      if (Math.abs(v) < stopSpeed(view.dpr)) camState.mom = null;
    }
  }
  if (anim) {
    anim.t += dt;
    const s = anim.kind === 'release' ? stretchReleased(anim.s0, anim.t) : stretchAbsorbed(anim.peak, anim.t);
    const done = anim.t > 0.04 && s < 0.0004;
    setStretch(done ? 0 : s);
    if (done) edge.anim = null;
  }
  return mom !== null || anim !== null;
}
