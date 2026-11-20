// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

import { blake2b } from '@noble/hashes/blake2.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { getVerifiedArtwork } from '@parity/product-sdk-nfts';
import { describe, expect, it } from 'vitest';

import { imageRefOfCid } from './cid';

/** Whether `getVerifiedArtwork` accepts `bytes` for `cid`: the hash functions
 *  and bad inputs of the app's CIDs, checked through the SDK's verifier. */
async function verifies(cid: string, bytes: Uint8Array): Promise<boolean> {
  const r = await getVerifiedArtwork(imageRefOfCid(cid), { source: async () => bytes });
  return r.ok && r.value.tag === 'Verified';
}

describe('content verification', () => {
  it('accepts bytes whose blake2b-256 digest matches the CID', async () => {
    // Reconstruct arbitrary content that hashes to a CID built here,
    // so the test needs no network: encode a CID from known bytes' digest.
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    expect(await verifies(cidForBlake2b(bytes), bytes)).toBe(true);
  });

  it('accepts sha2-256 CIDs too', async () => {
    const bytes = new TextEncoder().encode('hello scarcity');
    expect(await verifies(cidForSha256(bytes), bytes)).toBe(true);
  });

  it('rejects bytes that do not match the digest (tamper)', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const tampered = new Uint8Array([1, 2, 3, 4, 6]);
    expect(await verifies(cidForBlake2b(bytes), tampered)).toBe(false);
  });

  it('treats an unparseable CID as unverifiable (false, never true)', async () => {
    expect(await verifies('not-a-cid', new Uint8Array([1]))).toBe(false);
    // Malformed shapes: wrong multibase, empty, truncated.
    expect(await verifies('QmSomethingBase58btcCidV0', new Uint8Array([1]))).toBe(false);
    expect(await verifies('', new Uint8Array([1]))).toBe(false);
    expect(await verifies('b', new Uint8Array([1]))).toBe(false);
    expect(await verifies('b!!!!', new Uint8Array([1]))).toBe(false);
  });
});

// Helpers: build a base32 CIDv1 from a digest, mirroring the decoder. Hand-rolled
// and kept only here: this file tests the SDK's decode, so it cannot borrow it
// (other tests use testing/blakeCid.ts, which does). Also the one place
// sha2-256 CIDs exist.
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += B32.charAt((value >> bits) & 31);
    }
  }
  if (bits > 0) out += B32.charAt((value << (5 - bits)) & 31);
  return out;
}

function varint(n: number): number[] {
  const out: number[] = [];
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return out;
}

function cidFor(mhCode: number, digest: Uint8Array): string {
  const bytes = new Uint8Array([
    ...varint(1), // CIDv1
    ...varint(0x55), // raw codec
    ...varint(mhCode),
    ...varint(digest.length),
    ...digest,
  ]);
  return 'b' + base32Encode(bytes);
}

function cidForBlake2b(content: Uint8Array): string {
  return cidFor(0xb220, blake2b(content, { dkLen: 32 }));
}

function cidForSha256(content: Uint8Array): string {
  return cidFor(0x12, sha256(content));
}
