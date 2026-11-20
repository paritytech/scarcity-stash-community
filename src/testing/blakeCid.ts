// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// Test helper: a real CIDv1 (raw codec, blake2b-256) for given content bytes,
// so verification tests exercise the actual hashing path end to end instead of
// mocking the verdict. Not collected by vitest (no .test suffix) and never
// imported by app code. The encoding is the SDK's (artworkAddress, from the
// bare digest); only the digest is computed here. lib/cid.test.ts alone keeps
// an independent hand-rolled encoder, because there the decode is under test.

import { blake2b } from '@noble/hashes/blake2.js';
import { artworkAddress } from '@parity/product-sdk-nfts';

/** The CIDv1 whose digest is the blake2b-256 of `content`. */
export function blakeCid(content: Uint8Array): string {
  const digest = blake2b(content, { dkLen: 32 });
  const hex = `0x${Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')}`;
  const cid = artworkAddress({ hex, text: null })?.cid;
  if (!cid) throw new Error('artworkAddress returned no CID for a 32-byte digest');
  return cid;
}
