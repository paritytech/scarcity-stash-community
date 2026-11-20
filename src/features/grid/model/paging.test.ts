// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';

import type { CatalogueItem } from '@/entities/collections/catalogue';
import type { CatalogueSlot } from '@/entities/collections/catalogueStore';

import { buildFieldLayout } from './field';
import { pageList, tierPlace, wrapIndex } from './paging';

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

// Two collections: Sports with two tiers (3 rare, 23 common), Animals with a
// single tier of 6.
function field() {
  const sports = [
    ...Array.from({ length: 3 }, (_, k) => item('26', k, 'Rare')),
    ...Array.from({ length: 23 }, (_, k) => item('26', 3 + k, 'Common')),
  ];
  const animals = Array.from({ length: 6 }, (_, k) => item('30', k, 'Common'));
  return buildFieldLayout(
    [
      { id: '26', name: 'Sports' },
      { id: '30', name: 'Animals' },
    ],
    { '26': ready(sports), '30': ready(animals) },
    [],
  );
}

const everyThird = (i: number): boolean => i % 3 === 0;
const all = (): boolean => true;
const among =
  (set: readonly number[]) =>
  (i: number): boolean =>
    set.includes(i);
const range = (from: number, n: number): number[] => Array.from({ length: n }, (_, k) => from + k);

describe('paging through the pieces', () => {
  it('runs in the grid order: each tier of a collection in turn, then the next collection', () => {
    const L = field();
    const list = pageList(L, everyThird);
    const [first, second] = L.regions[0]!.areas.map((ai) => L.areas[ai]!);
    const [third] = L.regions[1]!.areas.map((ai) => L.areas[ai]!);
    const shownIn = (a: { from: number; to: number }) => range(a.from, a.to - a.from).filter(everyThird);
    expect(list).toEqual([...shownIn(first!), ...shownIn(second!), ...shownIn(third!)]);
    // Next on the last piece of a tier is the first of the next tier, and on
    // the last of a collection the first of the next collection.
    const lastOfFirst = shownIn(first!).at(-1)!;
    expect(list[list.indexOf(lastOfFirst) + 1]).toBe(shownIn(second!)[0]);
    const lastOfSports = shownIn(second!).at(-1)!;
    expect(list[list.indexOf(lastOfSports) + 1]).toBe(shownIn(third!)[0]);
  });

  it('goes round at either end', () => {
    const n = 7;
    expect(wrapIndex(n, n)).toBe(0);
    expect(wrapIndex(-1, n)).toBe(n - 1);
    expect(wrapIndex(3, n)).toBe(3);
    // Stepping one way through the whole list comes back to the start, and
    // the other way visits the same places in reverse.
    let idx = 0;
    const forward: number[] = [];
    for (let k = 0; k < n; k++) {
      idx = wrapIndex(idx + 1, n);
      forward.push(idx);
    }
    expect(forward).toEqual([1, 2, 3, 4, 5, 6, 0]);
    const back: number[] = [];
    for (let k = 0; k < n; k++) {
      idx = wrapIndex(idx - 1, n);
      back.push(idx);
    }
    expect(back).toEqual([6, 5, 4, 3, 2, 1, 0]);
    expect(wrapIndex(0, 0)).toBe(0);
  });

  it("leaves out the pieces the grid doesn't show as the player's", () => {
    const L = field();
    const held = L.areas[0]!.from;
    const list = pageList(L, (i) => i !== held);
    expect(list).not.toContain(held);
    expect(list).toHaveLength(L.cells.length - 1);
  });

  it('stays within a filter’s matches, in their order', () => {
    const L = field();
    expect(pageList(L, everyThird, [9, 3, 6, 4])).toEqual([9, 3, 6]);
    expect(pageList(L, everyThird, [])).toEqual([]);
  });

  it('places a piece among the player’s pieces in its tier, naming the tier and the collection', () => {
    const L = field();
    const commons = L.areas.find((a) => a.name === 'Common' && a.region === 0)!;
    const rares = L.areas.find((a) => a.name === 'Rare' && a.region === 0)!;
    const animals = L.areas.find((a) => a.region === 1)!;
    const six = range(commons.from, 6);
    expect(tierPlace(L, among(six), six[5]!)).toBe('6 of 6 Common in Sports');
    expect(tierPlace(L, among(six), six[0]!)).toBe('1 of 6 Common in Sports');
    expect(tierPlace(L, among([...six, ...range(rares.from, 3)]), rares.from)).toBe('1 of 3 Rare in Sports');
    expect(tierPlace(L, among(range(animals.from, 6)), animals.from + 1)).toBe('2 of 6 in Animals');
    // The only piece in its tier has the place alone.
    expect(tierPlace(L, among([rares.from]), rares.from)).toBe('Rare in Sports');
    expect(tierPlace(L, among([animals.from]), animals.from)).toBe('Animals');
  });

  it('changes the place as next crosses into another tier or collection', () => {
    const L = field();
    const list = pageList(L, all);
    const places = list.map((i) => tierPlace(L, all, i));
    const [first, second] = L.regions[0]!.areas.map((ai) => L.areas[ai]!);
    const boundary = list.findIndex((i) => i >= second!.from);
    expect(places[boundary - 1]).toContain(`${first!.name} in Sports`);
    expect(places[boundary]).toContain(`${second!.name} in Sports`);
    expect(places[boundary]).toMatch(/^1 of /);
    expect(places.at(-1)).toBe('6 of 6 in Animals');
  });
});
