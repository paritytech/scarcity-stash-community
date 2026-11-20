// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';

import { fakeRawClient } from '@/testing/fakeChain';

import { pinBlock, walkPages } from './nftsChain';

const page = (at: { blockHash: string; blockNumber: number }, nextId: number | null) => ({
  at,
  nextId,
});

describe('walkPages', () => {
  /** A paged read returning `pages` in order, recording each cursor as it was asked. */
  function reader(pages: ReturnType<typeof page>[]) {
    const asked: object[] = [];
    const fetchPage = async (cursor: object) => {
      asked.push({ ...cursor });
      return pages.shift() ?? null;
    };
    return { asked, fetchPage };
  }

  it('reads every page at the snapshot it was started on', async () => {
    const first = { blockHash: '0xbe57', blockNumber: 43 };
    const { asked, fetchPage } = reader([page(first, 5), page({ blockHash: '0xother', blockNumber: 44 }, null)]);
    await walkPages(fetchPage, first);
    expect(asked).toEqual([{ at: first }, { at: first, fromId: 5 }]);
  });

  it('started on a block name, joins every later page to the block the first page pinned', async () => {
    const pinned = { blockHash: '0xbe57', blockNumber: 43 };
    const { asked, fetchPage } = reader([page(pinned, 5), page({ blockHash: '0xother', blockNumber: 44 }, null)]);
    await walkPages(fetchPage, 'best');
    expect(asked).toEqual([{ at: 'best' }, { at: pinned, fromId: 5 }]);
  });
});

describe('pinBlock', () => {
  it('pins the newest block for best and the finalized one otherwise', async () => {
    const raw = fakeRawClient() as Parameters<typeof pinBlock>[0];
    expect(await pinBlock(raw, 'best')).toEqual({ blockHash: '0xbe57', blockNumber: 43 });
    expect(await pinBlock(raw, 'finalized')).toEqual({ blockHash: '0xf1a1', blockNumber: 41 });
  });
});
