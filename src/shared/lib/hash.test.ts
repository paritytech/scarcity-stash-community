// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';

import { normalizeHash, shortCode } from './hash';

describe('normalizeHash', () => {
  it('strips a 0x/0X prefix and lowercases', () => {
    expect(normalizeHash('0xABCD')).toBe('abcd');
    expect(normalizeHash('0XABcd')).toBe('abcd');
    expect(normalizeHash('ABCD')).toBe('abcd');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeHash('  0xAB12  ')).toBe('ab12');
  });

  it('passes synthetic identities through (lowercased)', () => {
    expect(normalizeHash('instance-42')).toBe('instance-42');
    expect(normalizeHash('Instance-42')).toBe('instance-42');
  });

  it('is idempotent', () => {
    const once = normalizeHash('0xDeadBeef');
    expect(normalizeHash(once)).toBe(once);
  });
});

describe('shortCode', () => {
  it('formats a long hex hash as head·tail, uppercased', () => {
    expect(shortCode('0x7f3a0000000000000000000000000000000000000000000000000000009c2b')).toBe('7F3A·9C2B');
  });

  it('passes synthetic (non-hex) identities through whole', () => {
    expect(shortCode('instance-42')).toBe('INSTANCE-42');
  });

  it('returns short hex whole rather than slicing past its length', () => {
    expect(shortCode('0xabcd')).toBe('ABCD');
  });
});
