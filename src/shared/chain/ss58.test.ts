// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

import { ss58Decode } from '@parity/product-sdk-address';
import { isValidSs58 } from '@parity/product-sdk-address';
import { describe, expect, it } from 'vitest';

import { ALICE_0, ALICE_42, ALICE_PUBKEY, BOB_42 } from '@/testing/fixtures';

import { addressOfPublicKey, publicKeyHexOf, sameAccount } from './ss58';

describe('isValidSs58', () => {
  it('accepts a valid address', () => {
    expect(isValidSs58(ALICE_42)).toBe(true);
  });

  it('rejects junk without throwing', () => {
    expect(isValidSs58('not-an-address')).toBe(false);
    expect(isValidSs58('')).toBe(false);
  });
});

describe('publicKeyHexOf', () => {
  it('extracts the public key as 0x-hex', () => {
    expect(publicKeyHexOf(ALICE_42)).toBe(ALICE_PUBKEY);
  });

  it('is network-prefix-independent (same key, different prefixes → same hex)', () => {
    expect(publicKeyHexOf(ALICE_0)).toBe(publicKeyHexOf(ALICE_42));
  });

  it('distinguishes different keys', () => {
    expect(publicKeyHexOf(BOB_42)).not.toBe(publicKeyHexOf(ALICE_42));
  });

  it('returns null for an unparseable address', () => {
    expect(publicKeyHexOf('not-an-address')).toBeNull();
  });
});

describe('addressOfPublicKey', () => {
  it('returns the address of a public key given as 0x-hex', () => {
    expect(addressOfPublicKey(ALICE_PUBKEY)).toBe(ALICE_42);
  });

  it('returns the same address for the public key given as bytes', () => {
    expect(addressOfPublicKey(ss58Decode(ALICE_42).publicKey)).toBe(ALICE_42);
  });
});

describe('sameAccount', () => {
  it('matches one account under two prefixes and rejects different or broken input', () => {
    expect(sameAccount(ALICE_42, ALICE_0)).toBe(true);
    expect(sameAccount(ALICE_42, ALICE_42)).toBe(true);
    expect(sameAccount(ALICE_42, BOB_42)).toBe(false);
    expect(sameAccount(ALICE_42, 'junk')).toBe(false);
    expect(sameAccount(null, ALICE_42)).toBe(false);
  });
});
