// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as HostContent from '@/shared/host/content';
import { blakeCid } from '@/testing/blakeCid';

import type * as VerifiedArt from './verifiedArt';

// The on-device store, as a fixture: `kept` is what a previous session left
// behind. The real module degrades to exactly this shape (null) in node.
const h = vi.hoisted(() => ({
  kept: null as null | { bytes: Uint8Array; type: string },
  getArt: vi.fn(async (_cid: string) => h.kept),
  putArt: vi.fn(async (_cid: string, _bytes: Uint8Array, _type: string) => {}),
  removeArt: vi.fn(async (_cid: string) => {}),
}));
vi.mock('./artStore', () => ({
  getArt: (cid: string) => h.getArt(cid),
  putArt: (cid: string, bytes: Uint8Array, type: string) => h.putArt(cid, bytes, type),
  removeArt: (cid: string) => h.removeArt(cid),
}));

// The real verdict (hash the bytes) runs unless a test forces one, the only
// way to exercise `transient`, which the real module returns only when the
// verifier itself fails. loadVerifiedContent keeps its module-internal verdict
// either way, so the network path still truly hashes.
const hc = vi.hoisted(() => ({ verdict: null as null | 'verified' | 'transient' | 'rejected' }));
vi.mock('@/shared/host/content', async (importOriginal) => {
  const real = await importOriginal<typeof HostContent>();
  return {
    ...real,
    verdictOfBytes: (cid: string, bytes: Uint8Array) =>
      hc.verdict ? Promise.resolve(hc.verdict) : real.verdictOfBytes(cid, bytes),
  };
});

import { cidFromUrl } from './verifiedArt';

let loadVerifiedArt: typeof VerifiedArt.loadVerifiedArt;

describe('cidFromUrl', () => {
  it('extracts the CID from a gateway /ipfs/<cid> URL', () => {
    const cid = 'bafk2bzacechcj4kc7msxk4ti6ysjlly66lt5wtl2bilquv7vmf3zuddxn24e6';
    expect(cidFromUrl(`https://gw.example/ipfs/${cid}`)).toBe(cid);
    expect(cidFromUrl(`https://gw.example/ipfs/${cid}?x=1`)).toBe(cid);
  });
  it('returns null for data URIs and plain URLs with no CID', () => {
    expect(cidFromUrl('data:image/svg+xml,<svg/>')).toBeNull();
    expect(cidFromUrl('https://example.com/art.png')).toBeNull();
  });
});

describe('loadVerifiedArt', () => {
  const content = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1]);
  let url: string;

  // A fresh module per test, so no picture stays cached from the test before.
  beforeEach(async () => {
    vi.resetModules();
    ({ loadVerifiedArt } = await import('./verifiedArt'));
    h.kept = null;
    hc.verdict = null;
    url = `https://gw.example/ipfs/${blakeCid(content)}`;
    // jsdom-free stubs for the browser APIs the loader touches.
    let n = 0;
    vi.stubGlobal('URL', {
      createObjectURL: () => `blob:mock-${n++}`,
      revokeObjectURL: () => {},
    });
    vi.stubGlobal(
      'Blob',
      class {
        constructor(public parts: unknown[]) {}
      },
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns a blob URL when the fetched bytes verify against the CID', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        headers: { get: () => 'image/webp' },
        arrayBuffer: async () => content.buffer.slice(0),
      })),
    );
    const src = await loadVerifiedArt(url);
    expect(src).toMatch(/^blob:/);
  });

  it("fetches from this network's gateway, whatever site the link points to", async () => {
    const spy = vi.fn(async (_url: string) => ({
      ok: true,
      headers: { get: () => 'image/webp' },
      arrayBuffer: async () => content.buffer.slice(0),
    }));
    vi.stubGlobal('fetch', spy);
    const { IPFS_GATEWAY } = await import('@/shared/chain/network');
    await loadVerifiedArt(`https://other.example/ipfs/${blakeCid(content)}`);
    expect(spy.mock.calls.map(([asked]) => asked)).toEqual([`${IPFS_GATEWAY}/ipfs/${blakeCid(content)}`]);
  });

  it('returns null when the bytes do NOT match the CID (tampered art)', async () => {
    const tampered = new Uint8Array([0, 0, 0]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        headers: { get: () => 'image/webp' },
        arrayBuffer: async () => tampered.buffer.slice(0),
      })),
    );
    expect(await loadVerifiedArt(url)).toBeNull();
  });

  it('returns null on a failed fetch, and null (no CID) for a data URI', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        headers: { get: () => null },
        arrayBuffer: async () => new ArrayBuffer(0),
      })),
    );
    expect(await loadVerifiedArt(url)).toBeNull();
    expect(await loadVerifiedArt('data:image/svg+xml,<svg/>')).toBeNull();
  });

  it('dedupes concurrent loads of the same CID to a single fetch', async () => {
    const spy = vi.fn(async () => ({
      ok: true,
      headers: { get: () => 'image/webp' },
      arrayBuffer: async () => content.buffer.slice(0),
    }));
    vi.stubGlobal('fetch', spy);
    const [a, b] = await Promise.all([loadVerifiedArt(url), loadVerifiedArt(url)]);
    expect(a).toBe(b);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('forgets a fetch that returned nothing, so the next load asks the gateway again', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        ++calls === 1
          ? { ok: false, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) }
          : {
              ok: true,
              headers: { get: () => 'image/webp' },
              arrayBuffer: async () => content.buffer.slice(0),
            },
      ),
    );
    expect(await loadVerifiedArt(url)).toBeNull();
    expect(await loadVerifiedArt(url)).toMatch(/^blob:/);
    expect(calls).toBe(2);
  });

  it('records a digest mismatch and never fetches that CID again', async () => {
    const tampered = new Uint8Array([0, 0, 0]);
    const spy = vi.fn(async () => ({
      ok: true,
      headers: { get: () => 'image/webp' },
      arrayBuffer: async () => tampered.buffer.slice(0),
    }));
    vi.stubGlobal('fetch', spy);
    expect(await loadVerifiedArt(url)).toBeNull();
    expect(await loadVerifiedArt(url)).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(h.putArt).not.toHaveBeenCalled();
  });

  it('reads from the bytes kept on this device without touching the network', async () => {
    h.kept = { bytes: content, type: 'image/webp' };
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    const src = await loadVerifiedArt(url);
    expect(src).toMatch(/^blob:/);
    expect(spy).not.toHaveBeenCalled();
  });

  it('keeps a row whose check only hiccuped: transient is no verdict to delete on', async () => {
    h.kept = { bytes: content, type: 'image/webp' };
    hc.verdict = 'transient'; // the verifier failed, not the bytes
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        headers: { get: () => 'image/webp' },
        arrayBuffer: async () => content.buffer.slice(0),
      })),
    );
    expect(await loadVerifiedArt(url)).toMatch(/^blob:/);
    expect(h.removeArt).not.toHaveBeenCalled();
  });

  it('drops a kept row that no longer verifies and asks the network instead', async () => {
    h.kept = { bytes: new Uint8Array([0, 0, 0]), type: 'image/webp' };
    const spy = vi.fn(async () => ({
      ok: true,
      headers: { get: () => 'image/webp' },
      arrayBuffer: async () => content.buffer.slice(0),
    }));
    vi.stubGlobal('fetch', spy);
    expect(await loadVerifiedArt(url)).toMatch(/^blob:/);
    expect(h.removeArt).toHaveBeenCalledWith(blakeCid(content));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('keeps freshly verified bytes on this device for the next launch', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        headers: { get: () => 'image/webp' },
        arrayBuffer: async () => content.buffer.slice(0),
      })),
    );
    await loadVerifiedArt(url);
    expect(h.putArt).toHaveBeenCalledTimes(1);
    const [cid, bytes, type] = h.putArt.mock.calls[0] as unknown as [string, Uint8Array, string];
    expect(cid).toBe(blakeCid(content));
    expect(Array.from(bytes)).toEqual(Array.from(content));
    expect(type).toBe('image/webp');
  });

  it('keeps nothing when the fetch returned nothing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) })),
    );
    expect(await loadVerifiedArt(url)).toBeNull();
    expect(h.putArt).not.toHaveBeenCalled();
  });
});
