// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';

import { chunk } from './chunk';

describe('chunk', () => {
  it('splits in order into runs of at most the size, the last one shorter', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([1, 2], 2)).toEqual([[1, 2]]);
  });

  it('is empty for no items', () => {
    expect(chunk([], 3)).toEqual([]);
  });
});
