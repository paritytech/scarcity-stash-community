// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';

import { cid32, GATEWAY as GW, manifestDoc } from '@/testing/fakeManifest';

import { type DisplayInput, imageUrlOf, imageUrlOfRef, resolveDisplay, withManifest } from './display';
import { type FetchedManifest, parseManifest } from './manifest';

/** An input with every field unset but the ones given. */
const input = (over: Partial<DisplayInput>): DisplayInput => ({
  name: null,
  collectionName: null,
  imageRef: null,
  attributes: {},
  ...over,
});

describe('imageUrlOf', () => {
  it('gives no picture for a link without a content id', () => {
    expect(imageUrlOf('https://x/i.png')).toBeUndefined();
    expect(imageUrlOf('http://x/i.png')).toBeUndefined();
  });

  it("routes a link's content id through this network's gateway, not the link's own site", () => {
    const cid = 'bafybeigdyrztexampleabcdefghijklmno';
    expect(imageUrlOf(`https://other.example/ipfs/${cid}`)).toBe(`${GW}/ipfs/${cid}`);
  });

  it('routes a multibase CID through the gateway', () => {
    const cid = 'bafybeigdyrztexampleabcdefghijklmno';
    expect(imageUrlOf(cid)).toBe(`${GW}/ipfs/${cid}`);
  });

  it('returns undefined for non-fetchable refs', () => {
    expect(imageUrlOf('bulletin:100:2')).toBeUndefined();
    expect(imageUrlOf('')).toBeUndefined();
  });
});

describe('imageUrlOfRef', () => {
  const hexOf = (s: string) =>
    `0x${Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, '0')).join('')}`;

  it('routes an ASCII CID string through the gateway', () => {
    const cid = 'bafybeigdyrztexampleabcdefghijklmno';
    expect(imageUrlOfRef({ hex: hexOf(cid), text: cid })).toBe(`${GW}/ipfs/${cid}`);
  });

  it('gives no picture for an ASCII link without a content id', () => {
    expect(imageUrlOfRef({ hex: hexOf('https://x/i.png'), text: 'https://x/i.png' })).toBeUndefined();
  });

  it('wraps a bare 32-byte blake2b-256 digest into its CID', () => {
    // A real on-chain image digest, which reconstructs to the CID the gateway
    // serves.
    const digest = '0xf274bda25b16ed029a83c5f08c5bf96aaa17446b55155df81e3a1c2285cce6aa';
    expect(imageUrlOfRef({ hex: digest, text: null })).toBe(
      `${GW}/ipfs/bafk2bzacedzhjpnclmlo2au2qpc7bdc37fvkuf2ennkrkxpydy5byiufzttku`,
    );
  });

  it('yields undefined for a value that is neither a fetchable string nor a 32-byte digest', () => {
    expect(imageUrlOfRef({ hex: hexOf('bulletin:100:2'), text: 'bulletin:100:2' })).toBeUndefined();
    expect(imageUrlOfRef({ hex: '0x010203', text: null })).toBeUndefined();
  });
});

describe('resolveDisplay', () => {
  it('extracts name and a fetchable image URL', () => {
    const cid = 'bafybeigdyrztexampleabcdefghijklmno';
    expect(resolveDisplay(input({ name: 'Sword', imageRef: { hex: '0x', text: cid } }))).toMatchObject({
      name: 'Sword',
      imageUrl: `${GW}/ipfs/${cid}`,
    });
  });

  it('omits imageUrl when the image ref is not fetchable', () => {
    const display = resolveDisplay(input({ name: 'Sword', imageRef: { hex: '0x', text: 'bulletin:1:2' } }));
    expect(display).toMatchObject({ name: 'Sword' });
    expect(display.imageUrl).toBeUndefined();
  });

  it('lists every attribute as the item metadata, and none when there are none', () => {
    expect(resolveDisplay(input({ attributes: { palette: 'warm', energy: '21' } })).metadata).toEqual({
      palette: 'warm',
      energy: '21',
    });
    expect(resolveDisplay(input({})).metadata).toBeUndefined();
  });
});

describe('the manifest keys on the display', () => {
  it('titles an item by its archetype and reads the tier; the collection name is not the item name', () => {
    const display = resolveDisplay(
      input({
        collectionName: 'Hearth',
        attributes: {
          manifest: cid32('m'),
          archetype: 'greek-coffee',
          rarity: 'legendary',
          name: 'Hearth',
          schema: '1',
          effectsLibrary: '0.1',
          maxTiltDeg: '24',
        },
      }),
    );
    expect(display).toMatchObject({
      name: 'Greek Coffee',
      archetype: 'greek-coffee',
      tier: 'legendary',
      manifest: cid32('m'),
    });
  });

  it('an item-level name still wins, and a legacy item falls back to the collection name', () => {
    expect(resolveDisplay(input({ name: 'Sword', attributes: { name: 'Sword', archetype: 'sword' } })).name).toBe(
      'Sword',
    );
    expect(resolveDisplay(input({ collectionName: 'Animals', attributes: { name: 'Animals' } })).name).toBe('Animals');
  });

  it('shows whatever name the table gives a level', () => {
    expect(
      resolveDisplay(input({ attributes: { archetype: 'dragon', rarity: '300', rarities: '100=Common,300=Epic' } })),
    ).toMatchObject({ tier: 'Epic', rare: true });
    expect(
      resolveDisplay(input({ attributes: { archetype: 'hare', rarity: '100', rarities: '100=Basic,300=Epic' } })),
    ).toMatchObject({ tier: 'Basic', rare: false });
  });

  it('ignores a manifest that is not a CID and an archetype that is not a slug', () => {
    const display = resolveDisplay(input({ attributes: { manifest: 'not a cid', archetype: 'Not A Slug' } }));
    expect(display.manifest).toBeUndefined();
    expect(display.archetype).toBeUndefined();
    expect(display.name).toBeUndefined();
  });
});

describe('withManifest', () => {
  const THUMBNAIL_URL = `${GW}/ipfs/${cid32('thumb')}`;
  const served = (archetype: string, rarity: string | number): FetchedManifest => ({
    manifest: parseManifest(manifestDoc(archetype, rarity)),
    transient: false,
  });
  const fold = (attributes: Record<string, string>, fetched: FetchedManifest) =>
    withManifest(resolveDisplay(input({ attributes })), attributes, fetched);

  it('takes the thumbnail of the manifest for the picture', () => {
    const display = fold({ archetype: 'greek-coffee', rarity: 'common' }, served('greek-coffee', 'common'));

    expect(display).toMatchObject({ name: 'Greek Coffee', tier: 'common', imageUrl: THUMBNAIL_URL });
  });

  it('takes the name and the tier from the manifest when the chain states neither', () => {
    const display = fold({ rarities: '100=Common,200=Rare' }, served('actor', 200));

    expect(display).toMatchObject({ name: 'Actor', tier: 'Rare', rare: true, imageUrl: THUMBNAIL_URL });
  });

  it('keeps the name and the tier the chain states', () => {
    const attributes = { archetype: 'actor', rarity: '200', rarities: '100=Common,200=Rare' };
    const display = withManifest(
      resolveDisplay(input({ name: 'Period Drama Actor', attributes })),
      attributes,
      served('actor', 200),
    );

    expect(display).toMatchObject({ name: 'Period Drama Actor', tier: 'Rare', rare: true, imageUrl: THUMBNAIL_URL });
  });

  it('ignores a manifest whose archetype contradicts the chain', () => {
    const display = fold({ archetype: 'greek-coffee', rarity: 'common' }, served('hare', 'common'));

    expect(display).toMatchObject({ name: 'Greek Coffee', tier: 'common' });
    expect(display.imageUrl).toBeUndefined();
    expect(display.artPending).toBeUndefined();
  });

  it('ignores a manifest whose rarity contradicts the chain', () => {
    const display = fold({ archetype: 'actor', rarity: '200', rarities: '100=Common,200=Rare' }, served('actor', 100));

    expect(display.tier).toBe('Rare');
    expect(display.imageUrl).toBeUndefined();
  });

  it('leaves the picture pending when no source served the manifest', () => {
    const display = fold({ archetype: 'greek-coffee' }, { manifest: null, transient: true });

    expect(display).toMatchObject({ name: 'Greek Coffee', artPending: true });
    expect(display.imageUrl).toBeUndefined();
  });

  it('reads the archetype from the metadata, so it works on an NFT too', () => {
    const nft = { hash: 'h', name: 'Greek Coffee' };
    const attributes = { archetype: 'greek-coffee' };

    expect(withManifest(nft, attributes, served('hare', 'common'))).toEqual(nft);
    expect(withManifest(nft, attributes, served('greek-coffee', 'common'))).toEqual({
      ...nft,
      tier: 'common',
      rare: false,
      imageUrl: THUMBNAIL_URL,
    });
  });

  it('changes nothing when the manifest was rejected for good', () => {
    const attributes = { archetype: 'greek-coffee' };
    const display = resolveDisplay(input({ attributes }));

    expect(withManifest(display, attributes, { manifest: null, transient: false })).toEqual(display);
  });
});
