// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { blakeCid } from '@/testing/blakeCid';

import type * as Manifest from './manifest';

// The on-device store as a fixture, like verifiedArt.test.ts: `kept` is what a
// previous session left behind; the real module degrades to null in node.
const store = vi.hoisted(() => ({
  kept: null as null | { bytes: Uint8Array; type: string },
  getArt: vi.fn(async (_cid: string) => store.kept),
  putArt: vi.fn(async (_cid: string, _bytes: Uint8Array, _type: string) => {}),
  removeArt: vi.fn(async (_cid: string) => {}),
}));
vi.mock('./artStore', () => ({
  getArt: (cid: string) => store.getArt(cid),
  putArt: (cid: string, bytes: Uint8Array, type: string) => store.putArt(cid, bytes, type),
  removeArt: (cid: string) => store.removeArt(cid),
}));
import {
  compareRarities,
  humanizeArchetype,
  parseManifest,
  parseRarities,
  rarityName,
  thumbnailUrlOf,
} from './manifest';

const GW = 'https://gw.example';
const cid = (s: string) =>
  'b' + 'a'.repeat(58).replace(/a/g, () => 'abcdefghijklmnopqrstuvwxyz234567'[s.charCodeAt(0) % 32]!);
const asset = (name: string, extra: Record<string, unknown> = {}) => ({
  cid: cid(name),
  mime: 'image/webp',
  w: 768,
  h: 768,
  bytes: 1000,
  ...extra,
});

const good = () => ({
  schema: 1,
  collectionId: 3,
  archetype: 'greek-coffee',
  rarity: 'common',
  assets: {
    baseImage: asset('b'),
    heightMap: asset('h', { mime: 'image/png', bitDepth: 16 }),
    thumbnail: asset('t', { w: 512, h: 512 }),
  },
  render: [
    {
      effect: 'parallax',
      inputs: { colour: 'baseImage', height: 'heightMap' },
      params: { depthScale: 0.35, tilt: { source: 'gyro', range: [-1, 1] } },
    },
  ],
});

describe('parseManifest', () => {
  it('accepts a full schema 1 manifest and keeps only what the app reads', () => {
    expect(parseManifest(good())).toEqual({
      schema: 1,
      collectionId: 3,
      archetype: 'greek-coffee',
      rarity: 'common',
      assets: { thumbnail: asset('t', { w: 512, h: 512 }) },
    });
  });
  it('accepts a document without the base image, the height map or render stages', () => {
    const doc: Record<string, unknown> = { ...good(), assets: { thumbnail: asset('t') } };
    delete doc.render;
    expect(parseManifest(doc)?.assets.thumbnail.cid).toBe(cid('t'));
  });
  it('rejects another schema, a missing required asset, a bad tier or a bad slug', () => {
    expect(parseManifest({ ...good(), schema: 2 })).toBeNull();
    const noThumb = good();
    delete (noThumb.assets as Record<string, unknown>).thumbnail;
    expect(parseManifest(noThumb)).toBeNull();
    expect(parseManifest({ ...good(), rarity: '' })).toBeNull();
    expect(parseManifest({ ...good(), rarity: '200' })).toBeNull();
    expect(parseManifest({ ...good(), rarity: 1.5 })).toBeNull();
    expect(parseManifest({ ...good(), rarity: 0 })).toBeNull();
    expect(parseManifest({ ...good(), archetype: 'Greek Coffee' })).toBeNull();
    expect(parseManifest(null)).toBeNull();
  });
  it('keeps a level as stated', () => {
    expect(parseManifest({ ...good(), rarity: 200 })!.rarity).toBe(200);
  });
  it('rejects a JPEG thumbnail', () => {
    const m = good();
    (m.assets.thumbnail as { mime: string }).mime = 'image/jpeg';
    expect(parseManifest(m)).toBeNull();
  });
});

describe('thumbnailUrlOf', () => {
  it('names the thumbnail on the gateway', () => {
    expect(thumbnailUrlOf(parseManifest(good())!, GW)).toBe(`${GW}/ipfs/${cid('t')}`);
  });
});

describe('humanizeArchetype', () => {
  it('titles a slug', () => {
    expect(humanizeArchetype('greek-coffee')).toBe('Greek Coffee');
    expect(humanizeArchetype('japanese-hannya-mask')).toBe('Japanese Hannya Mask');
    expect(humanizeArchetype('hare')).toBe('Hare');
  });
});

describe('parseRarities / rarityName / compareRarities', () => {
  it('reads a collection table, every name as written', () => {
    expect([...parseRarities('100=Common,200=Rare')]).toEqual([
      [100, 'Common'],
      [200, 'Rare'],
    ]);
    expect([...parseRarities(' 100 = Common , 300=Epic ,400=')]).toEqual([
      [100, 'Common'],
      [300, 'Epic'],
    ]);
  });
  it('gives a collection that sets no table the older collections’ default', () => {
    const fallback = [...parseRarities('100=common,200=uncommon,300=rare,400=legendary')];
    expect([...parseRarities(undefined)]).toEqual(fallback);
    expect([...parseRarities('400=')]).toEqual(fallback);
  });
  it('names a level through the table, and keeps a name an older collection wrote itself', () => {
    const table = parseRarities('100=Common,200=Rare');
    expect(rarityName('200', table)).toBe('Rare');
    expect(rarityName(100, table)).toBe('Common');
    expect(rarityName('legendary', table)).toBe('legendary');
    expect(rarityName('300', table)).toBeUndefined();
    expect(rarityName('200', new Map())).toBeUndefined();
    expect(rarityName('', table)).toBeUndefined();
  });
  it('compares two rarities by name through the table', () => {
    const oneWorld = parseRarities('100=Common,200=Uncommon,300=Rare,400=Legendary');
    expect(compareRarities('Rare', 'Common', oneWorld)).toBeGreaterThan(0);
    expect(compareRarities('uncommon', 'LEGENDARY', oneWorld)).toBeLessThan(0);
    expect(compareRarities('Rare', 'Rare', oneWorld)).toBe(0);
    expect(compareRarities('Epic', 'Common', oneWorld)).toBe(0);
    expect(compareRarities(undefined, 'Common', oneWorld)).toBe(0);
  });
});

describe('readManifest', () => {
  // A fresh module per launch, so no manifest stays cached from the one before.
  let readManifest: typeof Manifest.readManifest;
  const launch = async (): Promise<void> => {
    vi.resetModules();
    ({ readManifest } = await import('./manifest'));
  };
  const manifestAt = (cid: string, gateway: string) => readManifest(cid, gateway).then((r) => r.manifest);

  beforeEach(launch);
  afterEach(() => {
    vi.unstubAllGlobals();
    store.kept = null;
  });
  const bytesOf = (doc: unknown) => new TextEncoder().encode(JSON.stringify(doc));
  const cidOf = blakeCid;
  const respond = (bytes: Uint8Array<ArrayBuffer>, ok = true) =>
    vi.fn(async () => new Response(bytes, { status: ok ? 200 : 404 }));

  it('fetches from the gateway, verifies the bytes against the CID and parses', async () => {
    const bytes = bytesOf(good());
    const c = cidOf(bytes);
    const fetchSpy = respond(bytes);
    vi.stubGlobal('fetch', fetchSpy);
    const m = await manifestAt(c, GW);
    expect(m?.archetype).toBe('greek-coffee');
    // the gateway is asked with an abort signal, so the URL is pinned and the options are not
    expect(fetchSpy).toHaveBeenCalledWith(`${GW}/ipfs/${c}`, expect.anything());
  });
  it('returns null when the bytes do not hash to the CID, and caches that verdict', async () => {
    const bytes = bytesOf(good());
    const other = cidOf(bytesOf({ ...good(), archetype: 'hare' }));
    const fetchSpy = respond(bytes);
    vi.stubGlobal('fetch', fetchSpy);
    expect(await manifestAt(other, GW)).toBeNull();
    expect(await manifestAt(other, GW)).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
  it('dedupes concurrent loads of one CID and rejects a malformed CID without fetching', async () => {
    const bytes = bytesOf(good());
    const c = cidOf(bytes);
    const fetchSpy = respond(bytes);
    vi.stubGlobal('fetch', fetchSpy);
    const [a, b] = await Promise.all([manifestAt(c, GW), manifestAt(c, GW)]);
    expect(a).toBe(b);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(await manifestAt('not-a-cid', GW)).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
  it('keeps a verified document on this device and reads from it when no source has it', async () => {
    const bytes = bytesOf(good());
    const c = cidOf(bytes);
    vi.stubGlobal('fetch', respond(bytes));
    await manifestAt(c, GW);
    expect(store.putArt).toHaveBeenCalledTimes(1);
    expect(store.putArt.mock.calls[0]![0]).toBe(c);
    // The next launch: the gateway fails, the kept bytes still address the art.
    await launch();
    store.kept = { bytes, type: 'application/json' };
    const offline = respond(bytes, false);
    vi.stubGlobal('fetch', offline);
    expect((await manifestAt(c, GW))?.archetype).toBe('greek-coffee');
    expect(offline).not.toHaveBeenCalled();
  });

  it('keeps nothing for bytes that verified but are no manifest', async () => {
    const bytes = new TextEncoder().encode('not a manifest');
    const c = cidOf(bytes);
    vi.stubGlobal('fetch', respond(bytes));
    expect(await manifestAt(c, GW)).toBeNull();
    expect(store.putArt).not.toHaveBeenCalled();
  });

  it('marks a document no source served as one that may still come, and asks again; wrong bytes never will', async () => {
    const bytes = bytesOf(good());
    const c = cidOf(bytes);
    vi.stubGlobal('fetch', respond(bytes, false));
    expect(await readManifest(c, GW)).toEqual({ manifest: null, transient: true });
    vi.stubGlobal('fetch', respond(bytes));
    expect((await readManifest(c, GW)).manifest?.archetype).toBe('greek-coffee');
    const other = cidOf(bytesOf({ ...good(), archetype: 'hare' }));
    expect(await readManifest(other, GW)).toEqual({ manifest: null, transient: false });
    expect(await readManifest('not-a-cid', GW)).toEqual({ manifest: null, transient: false });
  });
});
