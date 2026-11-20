// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// The grid's top and bottom while it scrolls. Pulled past an end, the grid
// stays there and stretches a little instead, as Android's lists do, and
// relaxes when let go; a fling that meets an end stretches it briefly. Pure,
// so the curves are tested without a DOM.

/** The most the grid stretches, as a share of its height. */
export const STRETCH_MAX = 0.1;
/** How quickly a pull runs into STRETCH_MAX. */
const STIFFNESS = 2;
/** How fast a stretch dies away, per second, as WebKit's and Chromium's
 *  scrollers settle. */
const SETTLE_RATE = 12.5;

/** How much a pull of `x` px past an end stretches the grid on a screen `d`
 *  px tall: from 0, ever slower, towards STRETCH_MAX. */
export function stretchOf(x: number, d: number): number {
  if (x <= 0 || d <= 0) return 0;
  return STRETCH_MAX * (1 - 1 / ((x * STIFFNESS) / d + 1));
}

/** The pull that stretches the grid by `s`, so a drag that catches a stretch
 *  carries on from it. */
export function pullOf(s: number, d: number): number {
  if (s <= 0 || d <= 0) return 0;
  const f = Math.min(s / STRETCH_MAX, 0.999);
  return ((d / STIFFNESS) * f) / (1 - f);
}

/** A stretch of `s0`, `t` seconds after it was let go. */
export const stretchReleased = (s0: number, t: number): number => s0 * Math.exp(-SETTLE_RATE * t);

/** The stretch a fling meeting an end at `speed` px a second rises to. */
export const stretchPeak = (speed: number): number => STRETCH_MAX * Math.min(1, Math.abs(speed) / 6000);

/** That fling's stretch `t` seconds after it met the end: up to its peak and
 *  back down again. */
export const stretchAbsorbed = (peak: number, t: number): number =>
  peak * SETTLE_RATE * t * Math.exp(1 - SETTLE_RATE * t);
