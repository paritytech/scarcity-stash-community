// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';

import { pullOf, STRETCH_MAX, stretchAbsorbed, stretchOf, stretchPeak, stretchReleased } from './edge';

const D = 812;

describe('the stretch at the grid’s ends', () => {
  it('stretches ever less the further it is pulled, never past its most', () => {
    expect(stretchOf(0, D)).toBe(0);
    expect(stretchOf(-40, D)).toBe(0);
    const at = [100, 400, 1600, 10_000].map((x) => stretchOf(x, D));
    expect(at[0]).toBeGreaterThan(0.01);
    expect(at[1]).toBeCloseTo(0.0496, 3);
    for (let i = 1; i < at.length; i++) expect(at[i]! - at[i - 1]!).toBeGreaterThan(0);
    // Each further 400 px adds less than the one before.
    expect(stretchOf(800, D) - stretchOf(400, D)).toBeLessThan(stretchOf(400, D));
    expect(stretchOf(1e9, D)).toBeLessThanOrEqual(STRETCH_MAX);
  });

  it('turns back into the pull that makes it, so a drag that catches it carries on from there', () => {
    for (const x of [1, 30, 400, 1600]) expect(pullOf(stretchOf(x, D), D)).toBeCloseTo(x, 4);
    expect(pullOf(0, D)).toBe(0);
    expect(Number.isFinite(pullOf(STRETCH_MAX * 2, D))).toBe(true);
  });

  it('relaxes within about half a second once let go', () => {
    expect(stretchReleased(0.05, 0)).toBe(0.05);
    expect(stretchReleased(0.05, 0.2)).toBeLessThan(0.005);
    expect(stretchReleased(0.05, 0.4)).toBeLessThan(0.0004);
  });

  it('takes a fling that meets an end up to a peak by its speed and back', () => {
    const peak = stretchPeak(3000);
    expect(peak).toBeCloseTo(STRETCH_MAX / 2, 6);
    expect(stretchPeak(-3000)).toBe(peak);
    expect(stretchPeak(60_000)).toBe(STRETCH_MAX);
    const path = Array.from({ length: 50 }, (_, k) => stretchAbsorbed(peak, k / 100));
    expect(Math.max(...path)).toBeCloseTo(peak, 3);
    expect(stretchAbsorbed(peak, 0)).toBe(0);
    expect(stretchAbsorbed(peak, 0.8)).toBeLessThan(0.0004);
  });
});
