// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// The fling: how fast a drag was going when the finger lifted, how a fling
// slows down, and how a new fling adds to one still running. The numbers are
// iOS's, as Flutter measured them against UIScrollView: its velocity
// tracker, its normal deceleration rate and its momentum build-up on repeated
// flings. Android's scroller and Chromium build up repeated flings too. Pure,
// so the physics is tested without a DOM.

/** One finger position, px down the screen, at a time in ms. */
export interface Sample {
  t: number;
  y: number;
}

/** How many recent samples a drag keeps for its release speed. */
export const SAMPLES = 20;
/** A finger that has not moved for this long, ms, when it lifts had stopped. */
const STOPPED_MS = 40;
/** The slowest release that flings, and the fastest a release counts as, px a
 *  second. */
export const MIN_FLING = 100;
export const MAX_FLING = 8000;
/** UIScrollView's normal deceleration keeps 0.998 of the speed each ms. */
const KEPT_PER_MS = 0.998;
/** That deceleration as a rate, per second: about 2. */
export const FRICTION = -Math.log(KEPT_PER_MS) * 1000;
/** A finger held still this long during a drag, ms, loses the momentum it
 *  caught from a running fling. */
export const STILL_LOSES_MS = 20;

/** The speed of one move between samples, px a second: `back` 0 is the
 *  newest move, 1 the one before it. */
function moveSpeed(samples: readonly Sample[], back: number): number {
  const end = samples[samples.length - 1 - back];
  const start = samples[samples.length - 2 - back];
  if (!end || !start) return 0;
  const dt = end.t - start.t;
  return dt > 0 ? ((end.y - start.y) / dt) * 1000 : 0;
}

/** The finger's speed as it lifts, px a second, as iOS weighs it: the three
 *  newest moves at 0.6, 0.35 and 0.05, oldest first; 0 once it had stopped. */
export function releaseSpeed(samples: readonly Sample[], at: number): number {
  const last = samples[samples.length - 1];
  if (!last || at - last.t > STOPPED_MS) return 0;
  return moveSpeed(samples, 2) * 0.6 + moveSpeed(samples, 1) * 0.35 + moveSpeed(samples, 0) * 0.05;
}

/** The fling a release at `v` px a second starts: none below MIN_FLING, and
 *  never faster than MAX_FLING. */
export function flingSpeed(v: number): number {
  const s = Math.abs(v);
  if (s < MIN_FLING) return 0;
  return Math.sign(v) * Math.min(s, MAX_FLING);
}

/** Where a fling that started at `x0` px at `v0` px a second is `t` seconds
 *  on, and its speed then. */
export function coast(x0: number, v0: number, t: number): { x: number; v: number } {
  const kept = Math.exp(-FRICTION * t);
  return { x: x0 + (v0 * (1 - kept)) / FRICTION, v: v0 * kept };
}

/** The speed below which a fling stops, px a second: one device pixel per
 *  50 ms. */
export const stopSpeed = (dpr: number): number => 1 / (0.05 * Math.max(1, dpr));

/** What a fling still running at `v` px a second carries into a new fling,
 *  on iOS's curve: little from a slow one, a lot from a fast one. */
export const carriedMomentum = (v: number): number => Math.sign(v) * Math.min(0.000816 * Math.abs(v) ** 1.967, 40_000);

/** A fling of `v` px a second plus `carried` from the fling it caught, when
 *  both go the same way and the new one is over half as fast. */
export function withCarried(v: number, carried: number): number {
  if (v === 0 || carried === 0 || Math.sign(v) !== Math.sign(carried)) return v;
  return Math.abs(v) > Math.abs(carried) * 0.5 ? v + carried : v;
}
