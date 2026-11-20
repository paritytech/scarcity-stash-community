// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CatalogueItem } from '@/entities/collections/catalogue';
import { buildEntry } from '@/entities/nfts/format';

import { dayNumber } from './days';
import { detailInfo, hasInfo } from './detailInfo';
import { buildFieldLayout, overlayField } from './field';
import { criteriaCount, filterLabel, matchAll, NO_FILTER, onlyNew, spanOf } from './filter';
import { searchField } from './search';

const NOW = Date.UTC(2026, 9, 12, 12);
const DAY = 86_400;
const T0 = Math.floor(NOW / 1000);

function setup() {
  const items: CatalogueItem[] = [
    { itemIndex: 0, name: 'Latte', tier: 'Common', rare: false },
    { itemIndex: 1, name: 'Matcha', tier: 'Rare', rare: true },
    { itemIndex: 2, name: 'Oolong', tier: 'Rare', rare: true },
    { itemIndex: 3, name: 'Mocha', tier: 'Common', rare: false },
  ];
  const layout = buildFieldLayout(
    [{ id: '1', name: 'Coffee and Tea' }],
    { '1': { items: items.map((i) => ({ ...i, metadata: { rarities: '100=Common,200=Rare' } })), status: 'ready' } },
    [],
  );
  const mk = (idx: number, n: number, daysAgo: number) => ({
    ...buildEntry({
      hash: n.toString(16).padStart(64, '0'),
      name: items[idx]!.name,
      collectionId: '1',
      itemIndex: idx,
    }),
    acquiredAt: T0 - daysAgo * DAY,
    lastMoved: T0 - daysAgo * DAY,
  });
  const latte = mk(0, 1, 9);
  const matcha = mk(1, 2, 0);
  const pieces = overlayField(layout, [latte, matcha], new Set([matcha.hash]), T0);
  return { layout, pieces, span: spanOf(pieces) };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const keyOf = (l: ReturnType<typeof setup>['layout'], i: number) => l.cells[i]!.items[0];

describe('filter', () => {
  it('spans from the first find to today', () => {
    const { span } = setup();
    expect(span.last).toBe(9);
    expect(span.first).toBe(dayNumber(T0 - 9 * DAY));
  });

  it('matches your rare pieces for Rare, and the rare ones to find with Missing', () => {
    const { layout, pieces, span } = setup();
    const rare = matchAll({ ...NO_FILTER, rare: true }, span, layout, pieces).map((i) => keyOf(layout, i));
    expect(rare).toEqual([1]);
    const toFind = matchAll({ ...NO_FILTER, rare: true, show: 'missing' }, span, layout, pieces).map((i) =>
      keyOf(layout, i),
    );
    expect(toFind).toEqual([2]);
  });

  it('keeps dates to pieces you hold', () => {
    const { layout, pieces, span } = setup();
    const lastWeek = matchAll({ ...NO_FILTER, d0: span.last - 6, d1: 1e9 }, span, layout, pieces).map((i) =>
      keyOf(layout, i),
    );
    expect(lastWeek).toEqual([1]);
    expect(filterLabel({ ...NO_FILTER, d0: span.last, d1: 1e9 }, span)).toBe('Today');
  });

  it('matches what arrived today for New, credits as well as held pieces', () => {
    const { layout, pieces, span } = setup();
    const latte = pieces.find((p) => p.look?.name === 'Latte')!.entries[0]!;
    const matcha = pieces.find((p) => p.look?.name === 'Matcha')!.entries[0]!;
    const credit = (idx: number, n: number, awardedAt: number) => ({
      ...buildEntry({ hash: n.toString(16).padStart(64, '0'), collectionId: '1', itemIndex: idx }),
      pending: true,
      mintedAt: awardedAt,
    });
    const today = credit(3, 7, T0 - 60);
    const older = credit(2, 8, T0 - 2 * DAY);
    const field = overlayField(layout, [latte, matcha, today, older], new Set(), T0);
    const f = { ...NO_FILTER, show: 'found' as const, isNew: true };
    const fresh = matchAll(f, span, layout, field).map((i) => keyOf(layout, i));
    expect(new Set(fresh)).toEqual(new Set([1, 3]));
  });

  it('names and counts what is on', () => {
    const { span } = setup();
    const f = { ...NO_FILTER, show: 'found' as const, isNew: true };
    expect(onlyNew(f, span)).toBe(true);
    expect(filterLabel(f, span)).toBe('New');
    expect(criteriaCount({ ...NO_FILTER, rare: true, show: 'missing' }, span)).toBe(2);
    expect(filterLabel({ ...NO_FILTER, rare: true, show: 'missing' }, span)).toBe('Rare, missing');
  });
});

describe('search', () => {
  it('finds only the names of pieces you hold', () => {
    const { layout, pieces } = setup();
    expect(searchField('o', layout, pieces).pieces).toEqual([]);
    expect(searchField('mat', layout, pieces).pieces.map((i) => keyOf(layout, i))).toEqual([1]);
    expect(searchField('oolong', layout, pieces).pieces).toEqual([]);
  });

  it('finds collections and tiers by name', () => {
    const { layout, pieces } = setup();
    expect(searchField('coffee', layout, pieces).places).toEqual([{ region: 0 }]);
    expect(searchField('rare', layout, pieces).places).toEqual([{ region: 0, area: 1 }]);
  });

  it('lists the newest finds for an empty query', () => {
    const { layout, pieces } = setup();
    expect(searchField('', layout, pieces).pieces.map((i) => keyOf(layout, i))).toEqual([1, 0]);
  });
});

describe('detailInfo', () => {
  const traits = {
    traits: 'caffeine,first_year',
    traitLabels: 'Caffeine,First recorded',
    traitUnits: 'mg,year',
    traitScoreMax: '100,100',
  };

  it('reads the description and the traits the collection lists', () => {
    const info = detailInfo({
      description: 'A green tea.',
      ...traits,
      caffeine: '63',
      caffeine_score: '23',
      first_year: '1840',
    });
    expect(info.desc).toBe('A green tea.');
    expect(info.traits.map((t) => [t.label, t.value, t.unit, t.score?.text])).toEqual([
      ['Caffeine', '63', 'mg', '23'],
      ['First recorded', '1840', 'year', undefined],
    ]);
  });

  it('skips values the chain could not read and a description the whole collection shares', () => {
    const info = detailInfo(
      { description: 'Every piece says this.', ...traits, caffeine: '0xdeadbeef' },
      'Every piece says this.',
    );
    expect(hasInfo(info)).toBe(false);
  });
});
