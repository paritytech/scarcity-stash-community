// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';

import {
  carriedMomentum,
  coast,
  flingSpeed,
  FRICTION,
  MAX_FLING,
  MIN_FLING,
  releaseSpeed,
  type Sample,
  stopSpeed,
  withCarried,
} from './fling';

/** A drag of one move per entry of `speeds`, `dt` ms apart, each `speeds[k]` px a second. */
function drag(speeds: readonly number[], dt = 16): Sample[] {
  const out: Sample[] = [{ t: 0, y: 0 }];
  for (const v of speeds) {
    const last = out[out.length - 1]!;
    out.push({ t: last.t + dt, y: last.y + (v * dt) / 1000 });
  }
  return out;
}

describe('the release speed', () => {
  it('reads a steady drag at its speed, in either direction', () => {
    const down = drag([3000, 3000, 3000, 3000, 3000]);
    expect(releaseSpeed(down, down.at(-1)!.t)).toBeCloseTo(3000, 6);
    const up = drag([-1800, -1800, -1800, -1800]);
    expect(releaseSpeed(up, up.at(-1)!.t + 8)).toBeCloseTo(-1800, 6);
  });

  it('weighs the three newest moves as iOS does, 0.6, 0.35 and 0.05 from the oldest', () => {
    const s = drag([500, 1000, 2000, 4000]);
    expect(releaseSpeed(s, s.at(-1)!.t)).toBeCloseTo(1000 * 0.6 + 2000 * 0.35 + 4000 * 0.05, 6);
  });

  it('is nothing once the finger had stopped before it lifted', () => {
    const s = drag([3000, 3000, 3000, 3000]);
    expect(releaseSpeed(s, s.at(-1)!.t + 40)).toBeGreaterThan(0);
    expect(releaseSpeed(s, s.at(-1)!.t + 41)).toBe(0);
    expect(releaseSpeed([], 0)).toBe(0);
  });

  it('flings only from MIN_FLING up, and never faster than MAX_FLING', () => {
    expect(flingSpeed(MIN_FLING - 1)).toBe(0);
    expect(flingSpeed(-(MIN_FLING - 1))).toBe(0);
    expect(flingSpeed(2500)).toBe(2500);
    expect(flingSpeed(-20_000)).toBe(-MAX_FLING);
  });
});

describe('the coast', () => {
  it('slows as a UIScrollView does, keeping 0.998 of its speed each millisecond', () => {
    expect(coast(0, 3000, 0.001).v).toBeCloseTo(3000 * 0.998, 6);
    expect(coast(0, 3000, 1).v).toBeCloseTo(3000 * 0.998 ** 1000, 3);
    expect(FRICTION).toBeCloseTo(2.002, 3);
  });

  it('travels the speed over the rate in all, half of it in about a third of a second', () => {
    expect(coast(100, 3000, 60).x).toBeCloseTo(100 + 3000 / FRICTION, 3);
    expect(3000 / FRICTION).toBeCloseTo(1498.5, 0);
    expect(coast(0, 3000, 0.346).x).toBeCloseTo(1498.5 / 2, -1);
    expect(coast(0, -1000, 60).x).toBeCloseTo(-1000 / FRICTION, 3);
  });

  it('stops below a device pixel per 50 ms', () => {
    expect(stopSpeed(2)).toBe(10);
    expect(stopSpeed(3)).toBeCloseTo(6.67, 2);
    expect(stopSpeed(0.5)).toBe(20);
  });
});

describe('repeated flings', () => {
  it('carry little of a slow fling and a lot of a fast one, as iOS builds momentum', () => {
    expect(carriedMomentum(0)).toBe(0);
    expect(carriedMomentum(500)).toBeCloseTo(166, -1);
    expect(carriedMomentum(2000)).toBeCloseTo(2538, -1);
    expect(carriedMomentum(-2000)).toBeCloseTo(-2538, -1);
    expect(carriedMomentum(1e7)).toBe(40_000);
  });

  it('add the carried speed to a new fling going the same way, at least half as fast', () => {
    expect(withCarried(2000, 2538)).toBe(4538);
    expect(withCarried(-2000, -2538)).toBe(-4538);
    // Too slow a new fling, the other way, or no fling: the carried speed is lost.
    expect(withCarried(1200, 2538)).toBe(1200);
    expect(withCarried(-2000, 2538)).toBe(-2000);
    expect(withCarried(0, 2538)).toBe(0);
    expect(withCarried(2000, 0)).toBe(2000);
  });
});
