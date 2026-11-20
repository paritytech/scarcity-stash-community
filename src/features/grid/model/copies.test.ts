// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';

import type { CatalogueItem } from '@/entities/collections/catalogue';
import { buildEntry, type CollectibleEntry } from '@/entities/nfts/format';

import { copyPages, pageOf, startPage } from './copies';
import { buildFieldLayout, overlayField } from './field';

const NOW = 1_790_000_000;
const HOUR = 3_600;

const item = (itemIndex: number): CatalogueItem => ({
  itemIndex,
  name: `Piece ${String(itemIndex)}`,
});
const layout = () =>
  buildFieldLayout([{ id: '26', name: 'Sports' }], { '26': { items: [0, 1].map(item), status: 'ready' } }, []);

function held(itemIndex: number, n: number, lastMoved: number): CollectibleEntry {
  return { ...buildEntry({ hash: n.toString(16).padStart(64, '0'), collectionId: '26', itemIndex }), lastMoved };
}
function credit(itemIndex: number, n: number, rootedAt?: number): CollectibleEntry {
  return {
    ...buildEntry({ hash: n.toString(16).padStart(64, '0'), collectionId: '26', itemIndex, pending: true }),
    ...(rootedAt === undefined ? {} : { mintedAt: rootedAt }),
  };
}
const square = (entries: CollectibleEntry[], index = 0) => overlayField(layout(), entries, new Set(), NOW)[index]!;

describe('the pages of a square', () => {
  it('puts the copy you hold first, then each credit, newest first', () => {
    const today = credit(0, 2, NOW - HOUR);
    const older = credit(0, 3, NOW - 27 * 24 * HOUR);
    const pages = copyPages(square([held(0, 1, NOW - 27 * 24 * HOUR), older, today]));
    expect(pages.map((g) => (g.kind === 'own' ? 'own' : g.entry.hash))).toEqual(['own', today.hash, older.hash]);
  });

  it('gives a square of credits alone one page per credit and no page of its own', () => {
    const pages = copyPages(square([credit(1, 4, NOW - HOUR), credit(1, 5, NOW - 2 * HOUR)], 1));
    expect(pages.map((g) => g.kind)).toEqual(['credit', 'credit']);
  });

  it('opens on the first page, or with New showing on the first page with something new', () => {
    const p = square([held(0, 1, NOW - 27 * 24 * HOUR), credit(0, 2, NOW - HOUR), credit(0, 3, NOW - 30 * HOUR)]);
    const pages = copyPages(p);
    expect(startPage(p, pages, NOW, false)).toBe(0);
    expect(startPage(p, pages, NOW, true)).toBe(1);
  });

  it('opens on the square’s own page when the copy you hold is the new one', () => {
    const p = square([held(0, 1, NOW - HOUR), credit(0, 2, NOW - HOUR)]);
    expect(startPage(p, copyPages(p), NOW, true)).toBe(0);
  });

  it('opens on the first page when nothing there is new', () => {
    const p = square([held(0, 1, NOW - 30 * HOUR), credit(0, 2, NOW - 30 * HOUR)]);
    expect(startPage(p, copyPages(p), NOW, true)).toBe(0);
  });

  it('finds a credit’s page by its hash, and nothing for one that is not here', () => {
    const today = credit(0, 2, NOW - HOUR);
    const pages = copyPages(square([held(0, 1, NOW - 30 * HOUR), today]));
    expect(pageOf(pages, today.hashHex)).toBe(1);
    expect(pageOf(pages, `0x${'ff'.repeat(32)}`)).toBe(-1);
  });
});
