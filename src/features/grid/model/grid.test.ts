// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';

import type { CatalogueItem } from '@/entities/collections/catalogue';
import type { CatalogueSlot } from '@/entities/collections/catalogueStore';

import { buildFieldLayout } from './field';
import {
  CARD_PAD,
  DEFAULT_STEP,
  GIVE,
  giveScale,
  GUTTER,
  inkOf,
  LAST_STEP,
  layoutGrid,
  leftLine,
  lensPieceSide,
  overOf,
  pieceSize,
  restingStep,
  savedStepOf,
  stepBlend,
  STEPS,
} from './grid';

function item(collectionId: string, itemIndex: number, tier: string): CatalogueItem {
  return {
    itemIndex,
    name: `Piece ${collectionId}-${itemIndex}`,
    imageUrl: `https://art.example/${collectionId}/${itemIndex}.webp`,
    tier,
    rare: tier === 'Rare',
    metadata: { rarities: '100=Common,200=Rare' },
  };
}

const ready = (items: CatalogueItem[]): CatalogueSlot => ({ items, status: 'ready' });

// Two collections: one with two tiers (5 rare, 42 common), one with a single
// tier of 23.
function field() {
  const drinks = [
    ...Array.from({ length: 5 }, (_, k) => item('27', k, 'Rare')),
    ...Array.from({ length: 42 }, (_, k) => item('27', 5 + k, 'Common')),
  ];
  const sports = Array.from({ length: 23 }, (_, k) => item('26', k, 'Common'));
  return buildFieldLayout(
    [
      { id: '27', name: 'Coffee and Tea' },
      { id: '26', name: 'Sports' },
    ],
    { '27': ready(drinks), '26': ready(sports) },
    [],
  );
}

const rect = (r: Float32Array, i: number) => ({ x: r[i * 4]!, y: r[i * 4 + 1]!, w: r[i * 4 + 2]! });
const everyThird = (i: number): boolean => i % 3 === 0;
const all = (): boolean => true;
const none = (): boolean => false;

describe('the grid', () => {
  it('steps from every piece as a small dot at 21 across a phone to three across with names', () => {
    const L = field();
    const commons = L.areas.find((a) => a.name === 'Common' && a.region === 0)!;
    const perRow = STEPS.map((step) => {
      const g = layoutGrid(L, all, step, 390, 72, 100);
      const top = rect(g.rects, commons.from).y;
      let n = 0;
      for (let i = commons.from; i < commons.to; i++) if (rect(g.rects, i).y === top) n++;
      return n;
    });
    expect(perRow).toEqual([21, 13, 8, 5, 3]);
    expect(STEPS.map((s) => s.dots === true)).toEqual([true, true, false, false, false]);
    expect(STEPS.map((s) => s.names === true)).toEqual([false, false, false, false, true]);
    expect(STEPS[DEFAULT_STEP]!.cols).toBe(5);
    expect(STEPS[LAST_STEP]!.cols).toBe(3);
  });

  it('at the dots keeps every piece in its own cell, found or not', () => {
    const L = field();
    for (const step of STEPS.slice(0, 2)) {
      const g = layoutGrid(L, everyThird, step, 390, 72, 100);
      expect(g.dots).toBe(1);
      expect(g.words).toBe(0);
      for (let i = 0; i < L.cells.length; i++) expect(rect(g.rects, i).w).toBeCloseTo(g.pieceSide, 4);
    }
  });

  it('keeps every piece inside its card, and the cards in order', () => {
    const L = field();
    for (const step of STEPS) {
      const g = layoutGrid(L, everyThird, step, 390, 72, 100);
      for (let i = 0; i < L.cells.length; i++) {
        const r = rect(g.rects, i);
        expect(r.x).toBeGreaterThanOrEqual(GUTTER + CARD_PAD);
        expect(r.x + r.w).toBeLessThanOrEqual(390 - GUTTER - CARD_PAD + 0.01);
        expect(r.y).toBeGreaterThanOrEqual(72 + CARD_PAD);
      }
      const [a, b] = g.sections;
      expect(a!.y).toBe(72);
      expect(b!.y).toBeGreaterThan(a!.y + a!.h);
      for (let i = L.areas[0]!.from; i < L.areas[0]!.to; i++) {
        const r = rect(g.rects, i);
        expect(r.y + r.w).toBeLessThanOrEqual(a!.y + a!.h - CARD_PAD + 0.01);
      }
      expect(g.height).toBeGreaterThan(b!.y + b!.h);
    }
  });

  it('labels tiers only in a collection that has more than one', () => {
    const L = field();
    const g = layoutGrid(L, everyThird, STEPS[DEFAULT_STEP]!, 390, 72, 100);
    const shown = L.areas.map((a) => g.tiers[a.idx]!.shown);
    expect(shown).toEqual([1, 1, 0]);
  });

  it('draws no picture past its cell, at eight across or anywhere else', () => {
    const L = field();
    for (const width of [390, 1200])
      for (const step of STEPS.slice(2)) {
        const { pieceSide } = layoutGrid(L, everyThird, step, width, 72, 100);
        expect(pieceSize(pieceSide)).toBeLessThanOrEqual(pieceSide);
      }
    const eight = layoutGrid(L, everyThird, STEPS[2]!, 390, 72, 100);
    expect(pieceSize(eight.pieceSide)).toBeCloseTo(eight.pieceSide, 6);
  });

  it('rests on the small dots after a pinch out, and springs back to three across after a pinch in', () => {
    expect(restingStep(-0.3)).toBe(0);
    expect(restingStep(0.4, -2)).toBe(0);
    expect(restingStep(0.4, 2)).toBe(1);
    expect(restingStep(2.4)).toBe(2);
    expect(restingStep(3.6)).toBe(LAST_STEP);
    expect(restingStep(LAST_STEP + 0.3)).toBe(LAST_STEP);
    expect(STEPS[restingStep(LAST_STEP + 0.3)]!.cols).toBe(3);
  });

  it('blends two steps at a time and never past the ends, so nothing leaves its card', () => {
    const n = STEPS.length;
    expect(stepBlend(2.4, n)).toEqual({ a: 2, k: expect.closeTo(0.4, 6) });
    expect(stepBlend(LAST_STEP, n)).toEqual({ a: LAST_STEP - 1, k: 1 });
    expect(stepBlend(-0.5, n)).toEqual({ a: 0, k: 0 });
    expect(stepBlend(LAST_STEP + 0.6, n)).toEqual({ a: LAST_STEP - 1, k: 1 });
    expect(stepBlend(0.3, 1)).toEqual({ a: 0, k: 0 });
  });

  it('gives only a few per cent past either end, however far the pinch goes', () => {
    const far = 13;
    const close = 107;
    expect(overOf(50, far, close)).toBe(0);
    expect(overOf(far, far, close)).toBe(0);
    expect(overOf(far / 2, far, close)).toBe(-1);
    expect(overOf(far / 8, far, close)).toBe(-1);
    expect(overOf(far / Math.SQRT2, far, close)).toBeCloseTo(-0.5, 6);
    expect(overOf(close * 2, far, close)).toBe(1);
    expect(overOf(close * 16, far, close)).toBe(1);
    expect(GIVE).toBeLessThanOrEqual(0.05);
    expect(giveScale(1)).toBeCloseTo(1 + GIVE, 9);
    expect(giveScale(-1)).toBeCloseTo(1 - GIVE, 9);
    expect(giveScale(3)).toBeCloseTo(1 + GIVE, 9);
    expect(giveScale(0)).toBe(1);
  });

  it('opens on the step saved on the device, else on the default step', () => {
    expect(savedStepOf(0)).toBe(0);
    expect(savedStepOf(LAST_STEP)).toBe(LAST_STEP);
    expect(savedStepOf(LAST_STEP + 3)).toBe(LAST_STEP);
    expect(savedStepOf('2')).toBe(DEFAULT_STEP);
    expect(savedStepOf(-1)).toBe(DEFAULT_STEP);
    expect(savedStepOf(1.5)).toBe(DEFAULT_STEP);
    expect(savedStepOf(undefined)).toBe(DEFAULT_STEP);
  });

  it('at three across names every piece, a faded one as faintly as its picture', () => {
    expect(STEPS[LAST_STEP]!.names).toBe(true);
    expect(inkOf(false, 1)).toEqual({ piece: 1, name: 1 });
    const out = inkOf(true, 1);
    expect(out.name).toBe(out.piece);
    expect(out.piece).toBeLessThan(1);
    expect(inkOf(false, 0).name).toBe(0);
  });

  it('at three across counts a collection’s pieces still to find in one line under its last tier', () => {
    const L = field();
    const g = layoutGrid(L, everyThird, STEPS[LAST_STEP]!, 390, 72, 100);
    expect(g.words).toBe(1);
    const drinks = L.regions[0]!;
    const found: { y: number; w: number }[] = [];
    const rest: { x: number; y: number; w: number }[] = [];
    for (const ai of drinks.areas) {
      const a = L.areas[ai]!;
      for (let i = a.from; i < a.to; i++) (everyThird(i) ? found : rest).push(rect(g.rects, i));
    }
    expect(found.every((r) => r.w > 60)).toBe(true);
    const section = g.sections[0]!;
    expect(section.left).toBe(rest.length);
    expect(section.left).toBe(47 - found.length);
    const foot = Math.max(...found.map((r) => r.y + r.w));
    expect(section.leftY).toBeGreaterThan(foot);
    expect(section.y + section.h - CARD_PAD).toBeGreaterThan(section.leftY);
    // Every tier ends at its own pieces: no line of its own under it.
    for (const ai of drinks.areas) {
      const t = g.tiers[ai]!;
      expect(t.y + t.h).toBeLessThanOrEqual(section.leftY);
    }
    // Their cells gather where the line starts, none of them laid out as a dot row.
    expect(new Set(rest.map((r) => `${r.x},${r.y}`)).size).toBe(1);
    expect(rest[0]!.y).toBeGreaterThan(foot);
    expect(leftLine(section.left)).toBe(`${String(section.left)} more to collect`);
    expect(leftLine(1)).toBe('1 more to collect');
  });

  it('at three across has no line under a complete collection, and only labels and the line under an empty one', () => {
    const L = field();
    const full = layoutGrid(L, all, STEPS[LAST_STEP]!, 390, 72, 100);
    expect(full.sections.every((s) => s.left === 0)).toBe(true);
    const empty = layoutGrid(L, none, STEPS[LAST_STEP]!, 390, 72, 100);
    L.regions.forEach((r, ri) => {
      const s = empty.sections[ri]!;
      expect(s.left).toBe(r.areas.reduce((n, ai) => n + L.areas[ai]!.n, 0));
      // Each tier is its label alone, or nothing in a collection with one tier.
      for (const ai of r.areas) expect(empty.tiers[ai]!.h).toBeLessThanOrEqual(STEPS[LAST_STEP]!.tier);
      // The card holds its title, the labels of a collection with more than one tier, and the line.
      const step = STEPS[LAST_STEP]!;
      const labels = r.areas.length > 1 ? r.areas.length * step.tier + (r.areas.length - 1) * step.tierGap : 0;
      expect(s.h).toBeLessThanOrEqual(2 * CARD_PAD + step.head + labels + 30);
    });
  });

  it('counts nothing in words further out, where the pieces still to find are drawn', () => {
    const L = field();
    for (const step of STEPS.slice(0, LAST_STEP)) {
      const g = layoutGrid(L, everyThird, step, 390, 72, 100);
      expect(g.words).toBe(0);
      expect(g.sections.every((s) => s.left === 0)).toBe(true);
    }
  });

  it('fits more pieces of the same size on a wider screen', () => {
    const L = field();
    const phone = layoutGrid(L, everyThird, STEPS[DEFAULT_STEP]!, 390, 72, 100);
    const wide = layoutGrid(L, everyThird, STEPS[DEFAULT_STEP]!, 1200, 72, 100);
    expect(Math.abs(wide.pieceSide - phone.pieceSide)).toBeLessThan(4);
    expect(wide.inner).toBeGreaterThan(phone.inner * 2);
  });

  it('shows a piece through the lens at least as big as at six across, so the lens helps out at the dots', () => {
    const L = field();
    const five = layoutGrid(L, all, STEPS[DEFAULT_STEP]!, 390, 72, 100).pieceSide;
    const eight = layoutGrid(L, all, STEPS[2]!, 390, 72, 100).pieceSide;
    const dots = layoutGrid(L, all, STEPS[0]!, 390, 72, 100).pieceSide;
    const lens = lensPieceSide(390);
    expect(lens).toBeGreaterThan(eight);
    expect(lens).toBeLessThan(five);
    expect(lens).toBeCloseTo(52, 0);
    // The gain the lens adds on top of its glass: none close in, four times out at the dots.
    expect(Math.max(1, lens / five)).toBe(1);
    expect(Math.max(1, lens / dots)).toBeGreaterThan(3.5);
    expect(lensPieceSide(1200)).toBeCloseTo(lens, 0);
  });
});
