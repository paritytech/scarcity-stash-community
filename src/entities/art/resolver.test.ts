// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';

import { chainCollectible, tierLabel } from './resolver';

const RARE_HASH = '0x' + '00'.repeat(32); // roll 0 → rare by the hash bytes
const COMMON_HASH = '0x' + 'ff'.repeat(32); // roll 65535 → common by the hash bytes

describe('the stated tier over the hash roll', () => {
  it('legendary and uncommon read as rare, common as common, regardless of the hash', () => {
    expect(chainCollectible(COMMON_HASH, 'Acropolis', undefined, { tier: 'legendary' })).toMatchObject({
      isRare: true,
      tier: 'legendary',
    });
    expect(chainCollectible(COMMON_HASH, 'X', undefined, { tier: 'uncommon' })).toMatchObject({
      isRare: true,
    });
    expect(chainCollectible(RARE_HASH, 'Hare', undefined, { tier: 'common' })).toMatchObject({
      isRare: false,
      tier: 'common',
    });
  });
  it('a collection table decides what counts as rare, regardless of the names', () => {
    expect(chainCollectible(COMMON_HASH, 'Dragon', undefined, { tier: 'Epic', rare: true })).toMatchObject({
      isRare: true,
      tier: 'Epic',
    });
    expect(chainCollectible(RARE_HASH, 'Hare', undefined, { tier: 'Basic', rare: false })).toMatchObject({
      isRare: false,
      tier: 'Basic',
    });
    expect(chainCollectible(RARE_HASH, 'Tea', undefined, { tier: 'Common' })).toMatchObject({ isRare: false });
  });
  it('without a tier the hash roll decides', () => {
    expect(chainCollectible(RARE_HASH, 'Old', undefined).isRare).toBe(true);
    expect(chainCollectible(COMMON_HASH, 'Old', undefined).tier).toBeUndefined();
  });
});

describe('tierLabel', () => {
  it('names the stated tier when there is one, else the hash roll', () => {
    expect(tierLabel({ tier: 'legendary', isRare: true })).toBe('Legendary');
    expect(tierLabel({ tier: 'common', isRare: false })).toBe('Common');
    expect(tierLabel({ tier: 'Epic', isRare: true })).toBe('Epic');
    expect(tierLabel({ isRare: true })).toBe('Rare');
    expect(tierLabel({ isRare: false })).toBe('Standard');
  });
});

describe('a picture on its way', () => {
  it('is marked on a look without a picture', () => {
    expect(chainCollectible(COMMON_HASH, 'Caffe Latte', undefined, { artPending: true }).artPending).toBe(true);
  });
  it('a picture that is there drops the flag', () => {
    expect(
      chainCollectible(COMMON_HASH, 'Caffe Latte', 'https://x/t.webp', { artPending: true }).artPending,
    ).toBeUndefined();
  });
});
