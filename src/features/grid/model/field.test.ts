// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';

import type { CatalogueItem } from '@/entities/collections/catalogue';
import type { CatalogueSlot } from '@/entities/collections/catalogueStore';
import { buildEntry, type CollectibleEntry } from '@/entities/nfts/format';

import { buildFieldLayout, type FieldCollection, isNewAt, NEW_FOR, nextAgeOut, overlayField } from './field';

const hashOf = (n: number): string => n.toString(16).padStart(64, '0');

/** The moment New is judged at in these tests, Unix seconds. */
const NOW = 1_790_000_000;
const DAY = 86_400;

function item(collectionId: string, itemIndex: number, extra: Partial<CatalogueItem> = {}): CatalogueItem {
  return {
    itemIndex,
    name: `Piece ${collectionId}-${itemIndex}`,
    imageUrl: `https://art.example/${collectionId}/${itemIndex}.webp`,
    ...extra,
  };
}

function owned(
  collectionId: string,
  itemIndex: number,
  n: number,
  extra: Partial<CollectibleEntry> = {},
): CollectibleEntry {
  return {
    ...buildEntry({
      hash: hashOf(n),
      name: `Piece ${collectionId}-${itemIndex}`,
      imageUrl: `https://art.example/${collectionId}/${itemIndex}.webp`,
      collectionId,
      itemIndex,
    }),
    acquiredAt: 1_790_000_000 + n,
    ...extra,
  };
}

const ready = (items: CatalogueItem[]): CatalogueSlot => ({ items, status: 'ready' });

// Two sample collections: Animals with six tiers of these sizes, and Activities
// with one tier.
const SERIES: [string, number][] = [
  ['Birds', 25],
  ['Bugs', 46],
  ['Reptiles', 12],
  ['Land', 123],
  ['Pets', 124],
  ['Water', 94],
];
function sampleField() {
  const rarities = SERIES.map(([name], k) => `${k + 1}=${name}`).join(',');
  const animals: CatalogueItem[] = [];
  for (const [tier, n] of SERIES)
    for (let k = 0; k < n; k++) animals.push(item('1', animals.length, { tier, metadata: { rarities } }));
  const activities = Array.from({ length: 84 }, (_, k) => item('2', k));
  const collections: FieldCollection[] = [
    { id: '1', name: 'Animals' },
    { id: '2', name: 'Activities' },
  ];
  return buildFieldLayout(collections, { '1': ready(animals), '2': ready(activities) }, []);
}

describe('buildFieldLayout', () => {
  it('counts the cells of every tier of the two sample collections', () => {
    const l = sampleField();
    expect(l.areas.map((a) => [a.n, a.from, a.to])).toEqual([
      [25, 0, 25],
      [46, 25, 71],
      [12, 71, 83],
      [123, 83, 206],
      [124, 206, 330],
      [94, 330, 424],
      [84, 424, 508],
    ]);
    expect(l.cells).toHaveLength(508);
    expect(l.areaOf[424]).toBe(6);
  });

  it('orders tiers by level, names them, and names a single tier after its collection', () => {
    const l = sampleField();
    expect(l.areas.map((a) => a.name)).toEqual([...SERIES.map(([n]) => n), 'Activities']);
    expect(l.regions.map((r) => r.areas.length)).toEqual([6, 1]);
  });

  it('marks the region of a collection whose name is still being read', () => {
    const collections: FieldCollection[] = [
      { id: '5', name: 'Collection 5', nameLoading: true },
      { id: '6', name: 'Jobs' },
    ];
    const l = buildFieldLayout(collections, { '5': ready([item('5', 0)]), '6': ready([item('6', 0)]) }, []);
    expect(l.regions.map((r) => r.nameLoading)).toEqual([true, undefined]);
  });

  it('folds identical definitions into one artwork and numbers the artworks', () => {
    const items = [
      item('5', 0, { name: 'Hare', metadata: { manifest: 'bafyhare' } }),
      item('5', 1, { name: 'Hare', metadata: { manifest: 'bafyhare' } }),
      item('5', 2, { name: 'Earth', metadata: { manifest: 'bafyearth' } }),
    ];
    const l = buildFieldLayout([{ id: '5', name: 'Living World' }], { '5': ready(items) }, []);
    expect(l.cells).toHaveLength(2);
    expect(l.cells[0]!.items).toEqual([0, 1]);
    expect(l.cells.map((c) => [c.no, c.of])).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });

  it('shows only the held pieces of a collection whose catalogue could not be read', () => {
    const mine = [owned('7', 3, 1), owned('7', 3, 2), owned('7', 9, 3)];
    const l = buildFieldLayout([{ id: '7', name: 'Jobs' }], { '7': { items: null, status: 'failed' } }, mine);
    expect(l.regions[0]!.partial).toBe(true);
    expect(l.cells).toHaveLength(2);
    expect(l.cells.every((c) => c.no === undefined)).toBe(true);
    const pieces = overlayField(l, mine, new Set(), NOW);
    expect(pieces.map((p) => p.copies)).toEqual([2, 1]);
  });

  it('keeps a key per artwork, so a catalogue landing late moves no held piece out of its key', () => {
    const a = buildFieldLayout([{ id: '3', name: 'Sports' }], { '3': ready([item('3', 0), item('3', 1)]) }, []);
    const b = buildFieldLayout(
      [{ id: '3', name: 'Sports' }],
      { '3': ready([item('3', 0), item('3', 1), item('3', 2)]) },
      [],
    );
    expect(b.index.get(a.cells[1]!.key)).toBe(1);
  });

  it('keys a held piece the same before and after its catalogue lands', () => {
    const mine = [owned('7', 3, 1, { resolved: { ...owned('7', 3, 1).resolved, metadata: { manifest: 'bafy3' } } })];
    const before = buildFieldLayout([{ id: '7', name: 'Jobs' }], { '7': { items: null, status: 'loading' } }, mine);
    const after = buildFieldLayout(
      [{ id: '7', name: 'Jobs' }],
      {
        '7': ready([
          item('7', 2, { metadata: { manifest: 'bafy2' } }),
          item('7', 3, { metadata: { manifest: 'bafy3' } }),
        ]),
      },
      mine,
    );
    expect(after.index.get(before.cells[0]!.key)).toBe(1);
  });

  it('marks why a region lacks its full set', () => {
    const mine = [owned('7', 3, 1)];
    const why = (status: CatalogueSlot['status']) =>
      buildFieldLayout([{ id: '7', name: 'Jobs' }], { '7': { items: null, status } }, mine).regions[0]!.partialWhy;
    expect(why('loading')).toBe('loading');
    expect(why('failed')).toBe('failed');
    expect(why('skipped')).toBe('skipped');
  });

  it('places a held entry with no item index in its artwork cell', () => {
    const e = owned('7', 3, 1);
    const loose = { ...owned('7', 3, 2) };
    delete loose.itemIndex;
    const l = buildFieldLayout([{ id: '7', name: 'Jobs' }], { '7': { items: null, status: 'failed' } }, [e, loose]);
    expect(l.cells).toHaveLength(1);
    expect(overlayField(l, [e, loose], new Set(), NOW)[0]!.copies).toBe(2);
  });

  it('carries no name for any piece', () => {
    const l = sampleField();
    expect(JSON.stringify(l.cells)).not.toContain('Piece ');
  });
});

describe('overlayField', () => {
  const layout = () =>
    buildFieldLayout([{ id: '9', name: 'Coffee and Tea' }], { '9': ready([0, 1, 2, 3].map((k) => item('9', k))) }, []);

  it('marks held pieces with their copies, first find and newness', () => {
    const l = layout();
    const a = owned('9', 1, 1, { acquiredAt: 200 });
    const b = owned('9', 1, 2, { acquiredAt: 100, lastMoved: NOW - 60 });
    const pieces = overlayField(l, [a, b], new Set([b.hash]), NOW);
    expect(pieces[1]).toMatchObject({ status: 'owned', copies: 2, foundAt: 100, isNew: true, newCopies: 1 });
    expect(pieces[1]!.entries[0]!.hash).toBe(a.hash);
    expect(pieces[0]!.status).toBe('missing');
  });

  it('gives a missing piece no name or picture', () => {
    const l = layout();
    const pieces = overlayField(l, [owned('9', 2, 1)], new Set(), NOW);
    expect(pieces.filter((p) => p.status === 'missing').every((p) => p.look === undefined)).toBe(true);
    expect(JSON.stringify(pieces.filter((p) => p.status === 'missing'))).not.toContain('Piece');
  });

  it('places a credit at the item its preview names, found from its award', () => {
    const l = layout();
    const credit = { ...owned('9', 0, 5), pending: true, claimable: true };
    const piece = overlayField(l, [credit], new Set(), NOW)[0]!;
    expect(piece).toMatchObject({ status: 'credit', copies: 0 });
    expect(piece.credits.map((e) => e.hash)).toEqual([credit.hash]);
    expect(piece.look?.name).toBe('Piece 9-0');
    expect(piece.foundAt).toBe(1_790_000_005);
  });

  it('keeps a credit and a held copy of the same item in one cell, owned', () => {
    const l = layout();
    const credit = { ...owned('9', 2, 5), pending: true };
    const piece = overlayField(l, [credit, owned('9', 2, 6)], new Set(), NOW)[2]!;
    expect(piece).toMatchObject({ status: 'owned', copies: 1 });
    expect(piece.credits).toHaveLength(1);
  });

  it('stands a credit that names no collection nowhere', () => {
    const l = layout();
    const { collectionId: _c, itemIndex: _i, ...bare } = owned('9', 1, 5);
    const pieces = overlayField(l, [{ ...bare, pending: true }], new Set(), NOW);
    expect(pieces.every((p) => p.status === 'missing')).toBe(true);
  });

  it('gives a credit placed by its preview a cell before its catalogue lands', () => {
    const credit = { ...owned('9', 4, 5), pending: true };
    const l = buildFieldLayout([{ id: '9', name: 'Coffee and Tea' }], {}, [credit]);
    expect(l.cells).toHaveLength(1);
    expect(overlayField(l, [credit], new Set(), NOW)[0]!.status).toBe('credit');
  });

  it('counts the copies this device has not shown apart from those it has', () => {
    const l = layout();
    const old = owned('9', 0, 1);
    const fresh = owned('9', 0, 2);
    const p = overlayField(l, [old, fresh], new Set([fresh.hash]), NOW)[0]!;
    expect(p).toMatchObject({ copies: 2, newCopies: 1 });
  });
});

describe('New: what reached the player in the last 12 hours', () => {
  const layout = () =>
    buildFieldLayout([{ id: '9', name: 'Coffee and Tea' }], { '9': ready([0, 1, 2, 3].map((k) => item('9', k))) }, []);
  /** A credit at item `itemIndex`, rooted at `rootedAt`; with no time, not rooted yet. */
  const credit = (itemIndex: number, n: number, rootedAt?: number): CollectibleEntry => ({
    ...owned('9', itemIndex, n),
    pending: true,
    ...(rootedAt === undefined ? {} : { mintedAt: rootedAt }),
  });
  const HOUR = 3_600;

  it('keeps a held copy in New for 12 hours after it reached its purse', () => {
    expect(isNewAt(owned('9', 0, 1, { lastMoved: NOW - NEW_FOR + 1 }), NOW)).toBe(true);
    expect(isNewAt(owned('9', 0, 1, { lastMoved: NOW - NEW_FOR }), NOW)).toBe(false);
    // Minted long ago, received an hour ago: it arrived an hour ago.
    expect(isNewAt(owned('9', 0, 1, { mintedAt: NOW - 30 * DAY, lastMoved: NOW - HOUR }), NOW)).toBe(true);
  });

  it('keeps a credit in New for 12 hours after its root, and one with no root yet', () => {
    expect(isNewAt(credit(0, 1, NOW - 11 * HOUR), NOW)).toBe(true);
    expect(isNewAt(credit(0, 1, NOW - 13 * HOUR), NOW)).toBe(false);
    expect(isNewAt(credit(0, 1), NOW)).toBe(true);
  });

  it('counts nothing held as new without the time it arrived', () => {
    expect(isNewAt(owned('9', 0, 1), NOW)).toBe(false);
  });

  it('keeps what arrived at 23:59 in New at 00:01', () => {
    const late = new Date(2026, 9, 29, 23, 59).getTime() / 1000;
    const after = new Date(2026, 9, 30, 0, 1).getTime() / 1000;
    expect(isNewAt(credit(0, 1, late), after)).toBe(true);
    expect(isNewAt(owned('9', 0, 2, { lastMoved: late }), after)).toBe(true);
  });

  it('marks credits and held copies from the last 12 hours, and nothing older', () => {
    const pieces = overlayField(
      layout(),
      [
        owned('9', 0, 1, { lastMoved: NOW - HOUR }),
        owned('9', 1, 2, { lastMoved: NOW - DAY }),
        credit(2, 3, NOW - 2 * HOUR),
        credit(3, 4, NOW - DAY),
      ],
      new Set(),
      NOW,
    );
    expect(pieces.map((p) => [p.status, p.isNew])).toEqual([
      ['owned', true],
      ['owned', false],
      ['credit', true],
      ['credit', false],
    ]);
  });

  it('marks a piece held before when a credit for it arrived', () => {
    const pieces = overlayField(
      layout(),
      [owned('9', 2, 1, { lastMoved: NOW - DAY }), credit(2, 2, NOW - 10)],
      new Set(),
      NOW,
    );
    expect(pieces[2]).toMatchObject({ status: 'owned', isNew: true, newCopies: 0 });
  });

  it('keeps a copy this device never showed out of New when it arrived over 12 hours ago', () => {
    const old = owned('9', 0, 1, { lastMoved: NOW - 13 * HOUR });
    expect(overlayField(layout(), [old], new Set([old.hash]), NOW)[0]).toMatchObject({
      newCopies: 1,
      isNew: false,
    });
  });

  it('lets each one go 12 hours after it arrived', () => {
    const entries = [owned('9', 0, 1, { lastMoved: NOW - HOUR }), credit(1, 2, NOW - 2 * HOUR)];
    const countAt = (now: number): number =>
      overlayField(layout(), entries, new Set(), now).filter((p) => p.isNew).length;
    expect(countAt(NOW)).toBe(2);
    expect(countAt(NOW + 10 * HOUR)).toBe(1);
    expect(countAt(NOW + 11 * HOUR)).toBe(0);
  });

  it('names the moment the next one turns 12 hours old', () => {
    const entries = [
      owned('9', 0, 1, { lastMoved: NOW - HOUR }),
      credit(1, 2, NOW - 2 * HOUR),
      credit(2, 3),
      owned('9', 3, 4, { lastMoved: NOW - DAY }),
    ];
    expect(nextAgeOut(entries, NOW)).toBe(NOW - 2 * HOUR + NEW_FOR);
    expect(nextAgeOut(entries, NOW - 2 * HOUR + NEW_FOR)).toBe(NOW - HOUR + NEW_FOR);
    expect(nextAgeOut(entries, NOW + DAY)).toBeUndefined();
  });
});
