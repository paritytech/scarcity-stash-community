// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// What a credit would mint: `NftClaimsApi.preview_mints` runs the chain's own
// selector for a batch of (credit, collection) pairs. In a Random collection
// the item is the credit hash modulo the item count, so the preview is the mint. Item
// metadata is read with `ScarcityApi.metadata_batch` here, since the SDK's
// preview leaves out the attributes the manifest lives in.

import { MAX_INSTANCES_PER_READ } from '@parity/product-sdk-nfts';
import { Enum } from 'polkadot-api';

import { type DisplayInput, resolveDisplays } from '@/entities/art/display';
import type { Tier } from '@/entities/art/manifest';
import { type AssetHubApi, getChainApis } from '@/shared/chain/client';
import { SHOW } from '@/shared/chain/readAt';
import { chunk } from '@/shared/lib/chunk';
import { asText, textOrHex, toHex } from '@/shared/lib/metadataBytes';

/** What claiming one credit into one collection would mint. */
export interface MintPreview {
  outcome:
    | {
        kind: 'mints';
        item: number;
        name?: string;
        imageUrl?: string;
        artPending?: boolean;
        tier?: Tier;
        rare?: boolean;
        metadata?: Record<string, string>;
      }
    | { kind: 'fails' };
}

/** One (credit, collection) pair to preview. */
export interface PreviewPair {
  credit: string;
  collection: number;
}

/** Pairs per preview_mints call: the runtime rejects a 33rd with TooLarge. */
const PREVIEW_BATCH = 32;

/** One `metadata_batch` result: every pair of the three layers, as bytes. */
type MetadataLayers = Awaited<ReturnType<AssetHubApi['apis']['ScarcityApi']['metadata_batch']>>[number];

type MetadataQuery = Parameters<AssetHubApi['apis']['ScarcityApi']['metadata_batch']>[0][number];

/** All metadata of the queries, out[i] for queries[i], in parallel chunks
 *  of MAX_INSTANCES_PER_READ, the cap the SDK's own reads use. */
async function metadataBatch(api: AssetHubApi, queries: MetadataQuery[]): Promise<MetadataLayers[]> {
  const results = await Promise.all(
    chunk(queries, MAX_INSTANCES_PER_READ).map((part) => api.apis.ScarcityApi.metadata_batch(part, SHOW)),
  );
  return results.flat();
}

/** One layer's pairs by their key's text, as the SDK bags a layer. */
type Bag = Map<string, Uint8Array>;

function bagOf(layer: MetadataLayers['instance']): Bag {
  const bag: Bag = new Map();
  for (const [k, v] of layer) if (k && v) bag.set(textOrHex(k), v);
  return bag;
}

/** `key`'s value in the first of `bags` that sets it. */
const firstOf = (key: string, ...bags: Bag[]): Uint8Array | undefined => bags.find((bag) => bag.has(key))?.get(key);

/** The layers as resolver input, read as the SDK reads a minted NFT: each
 *  key from instance, then item, then collection, the most specific winning. */
function displayInputOfLayers(layers: MetadataLayers): DisplayInput {
  const collection = bagOf(layers.collection);
  const item = bagOf(layers.item);
  const own = bagOf(layers.instance);
  const attributes: Record<string, string> = {};
  for (const bag of [collection, item, own]) for (const [k, v] of bag) attributes[k] = textOrHex(v);
  const name = firstOf('name', own, item);
  const collectionName = collection.get('name');
  const image = firstOf('image', own, item, collection);
  return {
    name: name ? textOrHex(name) : null,
    collectionName: collectionName ? textOrHex(collectionName) : null,
    imageRef: image ? { hex: toHex(image), text: asText(image) } : null,
    attributes,
  };
}

/** What each pair would mint, out[i] for pairs[i]. Rejects only when the
 *  runtime rejects a whole batch; one pair's rejection is a `fails` outcome. */
export async function previewMintsMany(api: AssetHubApi, pairs: PreviewPair[]): Promise<MintPreview[]> {
  if (pairs.length === 0) return [];
  const results = await Promise.all(chunk(pairs, PREVIEW_BATCH).map((part) => previewChunk(api, part)));
  return results.flat();
}

async function previewChunk(api: AssetHubApi, pairs: PreviewPair[]): Promise<MintPreview[]> {
  const collections = pairs.map((p) => p.collection);
  const queries = pairs.map(({ credit, collection }) => ({
    credit: credit.startsWith('0x') ? credit : `0x${credit}`,
    collection,
  }));
  const outcomes = await api.apis.NftClaimsApi.preview_mints(queries, SHOW);

  const targets = outcomes.flatMap((o, i) =>
    o.type === 'Mints' ? [{ i, collection: collections[i]!, item: o.value.item }] : [],
  );
  const layers = targets.length
    ? await metadataBatch(
        api,
        targets.map((t) => Enum('Item', { collection: t.collection, item: t.item })),
      )
    : [];
  const resolved = await resolveDisplays(layers.map(displayInputOfLayers));
  const display = new Map<
    number,
    {
      name?: string;
      imageUrl?: string;
      artPending?: boolean;
      tier?: Tier;
      rare?: boolean;
      metadata?: Record<string, string>;
    }
  >();
  targets.forEach((t, k) => {
    const { name, imageUrl, artPending, tier, rare, metadata } = resolved[k]!;
    display.set(t.i, {
      ...(name ? { name } : {}),
      ...(imageUrl ? { imageUrl } : {}),
      ...(artPending ? { artPending } : {}),
      ...(tier ? { tier } : {}),
      ...(rare !== undefined ? { rare } : {}),
      ...(metadata ? { metadata } : {}),
    });
  });

  return outcomes.map((o, i) =>
    o.type === 'Mints'
      ? { outcome: { kind: 'mints', item: o.value.item, ...(display.get(i) ?? {}) } }
      : { outcome: { kind: 'fails' } },
  );
}

/** What each (credit, collection) pair would mint, PREVIEW_BATCH pairs per
 *  runtime call: the grid's previews. Positional: out[i] is for pairs[i]. */
export async function loadMintPreviewsMany(pairs: PreviewPair[]): Promise<MintPreview[]> {
  const apis = await getChainApis();
  if (!apis) throw new Error('no chain connection this session');
  return previewMintsMany(apis.assetHub, pairs);
}
