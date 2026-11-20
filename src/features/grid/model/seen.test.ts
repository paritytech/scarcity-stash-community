// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';

import { buildEntry } from '@/entities/nfts/format';

import { NEW_FOR, type PieceState } from './field';
import { unseenNew, unseenPieces } from './seen';

const NOW = 1_800_000_000;
const hash = (n: number): string => String(n).padStart(64, '0');

function piece(over: Partial<PieceState>): PieceState {
  return {
    status: 'owned',
    copies: 1,
    entries: [],
    isNew: false,
    newCopies: 0,
    credits: [],
    ...over,
  };
}

const copy = (n: number, lastMoved: number) =>
  buildEntry({ hash: hash(n), lastMoved, collectionId: '1', itemIndex: n });
const credit = (n: number) => ({ ...buildEntry({ hash: hash(n), collectionId: '1', itemIndex: n }), pending: true });

describe('New and unseen', () => {
  it('counts a New copy and a New credit until they are seen', () => {
    const p = piece({ entries: [copy(1, NOW - 100)], credits: [credit(2)] });
    expect(unseenNew(p, new Set(), NOW)).toEqual([hash(1), hash(2)]);
    expect(unseenNew(p, new Set([hash(1)]), NOW)).toEqual([hash(2)]);
    expect(unseenNew(p, new Set([hash(1), hash(2)]), NOW)).toEqual([]);
  });

  it('never counts a copy older than New, seen or not', () => {
    const p = piece({ entries: [copy(1, NOW - NEW_FOR)] });
    expect(unseenNew(p, new Set(), NOW)).toEqual([]);
  });

  it('names the pieces with something New and unseen', () => {
    const pieces = [
      piece({ entries: [copy(1, NOW - 10)] }),
      piece({ entries: [copy(2, NOW - NEW_FOR - 10)] }),
      piece({ status: 'credit', copies: 0, credits: [credit(3)] }),
    ];
    expect([...unseenPieces(pieces, new Set(), NOW)]).toEqual([0, 2]);
    expect([...unseenPieces(pieces, new Set([hash(3)]), NOW)]).toEqual([0]);
  });
});
