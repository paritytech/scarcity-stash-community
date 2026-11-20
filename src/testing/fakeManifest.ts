// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// An art manifest for tests, and a gateway that serves it.

import { vi } from 'vitest';

/** The gateway the app fetches art from. */
export const GATEWAY = 'https://paseo-bulletin-next-ipfs.polkadot.io';

/** A text that reads as a CID, made from `seed`. */
export const cid32 = (seed: string) =>
  'b' +
  Array.from(
    { length: 58 },
    (_, i) => 'abcdefghijklmnopqrstuvwxyz234567'[(seed.charCodeAt(i % seed.length) + i) % 32],
  ).join('');

/** A manifest document of one archetype and rarity, with its three pictures. */
export const manifestDoc = (archetype: string, rarity: string | number, collectionId = 1) => ({
  schema: 1,
  collectionId,
  archetype,
  rarity,
  assets: {
    baseImage: { cid: cid32('base'), mime: 'image/webp', w: 768, h: 768, bytes: 10 },
    heightMap: {
      cid: cid32('height'),
      mime: 'image/png',
      w: 768,
      h: 768,
      bitDepth: 16,
      bytes: 10,
    },
    thumbnail: { cid: cid32('thumb'), mime: 'image/webp', w: 512, h: 512, bytes: 10 },
  },
  render: [
    {
      effect: 'parallax',
      inputs: { colour: 'baseImage', height: 'heightMap' },
      params: { depthScale: 0.35, tilt: { source: 'gyro', range: [-1, 1] } },
    },
  ],
});

/** Makes the gateway serve `doc` under its CID, and return 404 for anything else. */
export async function serveManifest(doc: unknown) {
  const { blakeCid } = await import('./blakeCid');
  const bytes = new TextEncoder().encode(JSON.stringify(doc));
  const cid = blakeCid(bytes);
  const fetchSpy = vi.fn(async (url: string) => new Response(bytes, { status: url.endsWith(cid) ? 200 : 404 }));
  vi.stubGlobal('fetch', fetchSpy);
  return { cid, fetchSpy };
}
