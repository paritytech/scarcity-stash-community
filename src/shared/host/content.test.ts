// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  manager: null as null | { lookup: ReturnType<typeof vi.fn>; submit: ReturnType<typeof vi.fn> },
}));
vi.mock('@parity/product-sdk-host', () => ({ getPreimageManager: async () => h.manager }));

import { blakeCid } from '@/testing/blakeCid';

import { loadContentBytes, sniffType, verdictOfBytes } from './content';

// A real CIDv1 raw blake2b-256 of some bytes is not needed: the loader only
// reads the digest out of the CID to form the host key and lets the caller
// verify. Any well-formed CID does; this one is a manifest on paseo.
const CID = 'bafk2bzacebocvbq65kxn5nj6azb7ymmmyr7zokpdvbqfrffg7dld5lfdb3tj6';
const GATEWAY_URL = `https://gw.example/ipfs/${CID}`;
const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 1, 2, 3]);

describe('loadContentBytes', () => {
  beforeEach(() => {
    h.manager = null;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('takes the bytes from the host when they come first', async () => {
    const lookup = vi.fn((_key: string, cb: (p: Uint8Array | null) => void) => {
      cb(null);
      cb(webp);
      return { unsubscribe: vi.fn(), onInterrupt: vi.fn() };
    });
    h.manager = { lookup, submit: vi.fn() };
    // a gateway that never returns: only the host can resolve this load
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {})),
    );
    const got = await loadContentBytes(GATEWAY_URL, CID);
    expect(got?.type).toBe('image/webp');
    expect(Array.from(got!.bytes)).toEqual(Array.from(webp));
    expect(lookup.mock.calls[0]![0]).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('takes the bytes from the gateway while the host lookup is still silent', async () => {
    // a host whose lookup never calls back
    const lookup = vi.fn(() => ({ unsubscribe: vi.fn(), onInterrupt: vi.fn() }));
    h.manager = { lookup, submit: vi.fn() };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        headers: { get: () => 'image/webp' },
        arrayBuffer: async () => webp.buffer.slice(0),
      })),
    );
    const started = Date.now();
    const got = await loadContentBytes(GATEWAY_URL, CID);
    expect(got?.type).toBe('image/webp');
    expect(lookup).toHaveBeenCalled();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('falls back to the gateway when the host has no manager', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        headers: { get: () => 'image/webp' },
        arrayBuffer: async () => webp.buffer.slice(0),
      })),
    );
    const got = await loadContentBytes(GATEWAY_URL, CID);
    expect(got?.type).toBe('image/webp');
  });

  it('reports null, not a verdict, when neither the host nor the gateway has the bytes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        headers: { get: () => null },
        arrayBuffer: async () => new ArrayBuffer(0),
      })),
    );
    expect(await loadContentBytes(GATEWAY_URL, CID)).toBeNull();
  });
});

describe('verdictOfBytes', () => {
  it('verifies bytes whose blake2b digest is the CID, no network involved', async () => {
    expect(await verdictOfBytes(blakeCid(webp), webp)).toBe('verified');
  });
  it('rejects bytes that do not hash to the CID', async () => {
    expect(await verdictOfBytes(blakeCid(webp), new Uint8Array([0, 0, 0]))).toBe('rejected');
  });
});

describe('sniffType', () => {
  it('knows webp, png, jpeg and json, else octet-stream', () => {
    expect(sniffType(webp)).toBe('image/webp');
    expect(sniffType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0]))).toBe('image/png');
    expect(sniffType(new Uint8Array([0xff, 0xd8, 0xff]))).toBe('image/jpeg');
    expect(sniffType(new TextEncoder().encode('  {"a":1}'))).toBe('application/json');
    expect(sniffType(new Uint8Array([1, 2, 3]))).toBe('application/octet-stream');
  });
});
