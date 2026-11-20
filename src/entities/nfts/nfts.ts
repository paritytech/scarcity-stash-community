// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// The NFTs the grid shows, read in two parts. fetchNfts gets who holds what
// and how each NFT looks from the chain, and formatNfts turns that into NFTs.
// fetchArt gets one art manifest that the NFTs state, and addArt puts the
// manifests that arrived into the NFTs. So no NFT waits for its art, and no
// picture waits for another one.

import {
  type BlockSnapshot,
  getInstanceDisplays,
  type InstanceDisplay,
  MAX_INSTANCES_PER_READ,
} from '@parity/product-sdk-nfts';

import { manifestCidOf, resolveDisplay, withManifest } from '@/entities/art/display';
import { type FetchedManifest, readManifest } from '@/entities/art/manifest';
import type { AssetHubApi, ChainApis } from '@/shared/chain/client';
import { IPFS_GATEWAY } from '@/shared/chain/network';
import { nftsChain, pinBlock } from '@/shared/chain/nftsChain';
import { SHOW_AT } from '@/shared/chain/readAt';
import { chunk } from '@/shared/lib/chunk';
import { metadataValueHex } from '@/shared/lib/metadataBytes';

import type { OwnedNft } from './types';

/** The metadata key that carries an NFT's 32-byte identity hash. */
const HASH_METADATA_KEY = 'hash';

type NftsByOwner = Awaited<ReturnType<AssetHubApi['query']['Scarcity']['NftsByOwner']['getValues']>>;
type Nft = NonNullable<NftsByOwner[number]>;
type FoundDisplay = Extract<InstanceDisplay, { tag: 'Found' }>;

/** What one NFT read fetched from the chain. */
export interface RawNfts {
  addresses: string[];
  /** `Scarcity.NftsByOwner` of each address, in the same order. Undefined where the account holds no NFT. */
  nftsByOwner: NftsByOwner;
  /** The SDK's display of each held NFT. */
  displays: InstanceDisplay[];
}

/** The art manifest behind each manifest CID, as the gateway or the host gave it. */
export type Manifests = Record<string, FetchedManifest>;

/** Fetches who holds what, and how each held NFT looks, from the chain. */
export async function fetchNfts(apis: ChainApis, addresses: string[]): Promise<RawNfts> {
  // Both reads take the same block, so the second one knows every NFT the first one saw.
  const block = await pinBlock(apis.raw.assetHub, SHOW_AT);

  const nftsByOwner = await fetchNftsByOwner(apis, addresses, block);
  const displays = await fetchInstanceDisplays(apis, instancesOf(nftsByOwner), block);

  return { addresses, nftsByOwner, displays };
}

function fetchNftsByOwner(apis: ChainApis, addresses: string[], block: BlockSnapshot): Promise<NftsByOwner> {
  const keys = addresses.map((address) => [address] as [string]);
  return apis.assetHub.query.Scarcity.NftsByOwner.getValues(keys, { at: block.blockHash });
}

async function fetchInstanceDisplays(
  apis: ChainApis,
  instances: bigint[],
  block: BlockSnapshot,
): Promise<InstanceDisplay[]> {
  // The SDK returns at most 128 instances per call.
  const calls = chunk(instances, MAX_INSTANCES_PER_READ).map((part) =>
    getInstanceDisplays(nftsChain(apis), part, { at: block }),
  );
  const results = await Promise.all(calls);

  return results.flatMap((result) => {
    if (!result.ok) throw result.error;
    return result.value.displays;
  });
}

const instancesOf = (nftsByOwner: NftsByOwner): bigint[] => nftsByOwner.flatMap((nft) => (nft ? [nft.instance] : []));

/** Turns what an NFT read fetched into the NFTs the grid shows, without their art. An account that holds no NFT gives none. */
export function formatNfts({ addresses, nftsByOwner, displays }: RawNfts): OwnedNft[] {
  const displayOfInstance = new Map<bigint, FoundDisplay>();
  for (const display of displays) {
    if (display.tag === 'Found') displayOfInstance.set(display.instance, display);
  }

  return nftsByOwner.flatMap((nft, i) =>
    nft ? [formatNft(addresses[i]!, nft, displayOfInstance.get(nft.instance))] : [],
  );
}

function formatNft(address: string, nft: Nft, display: FoundDisplay | undefined): OwnedNft {
  const owned: OwnedNft = {
    hash: identityOf(nft, display),
    mintedAt: Number(nft.minted_at),
    lastMoved: Number(nft.last_moved),
    instance: nft.instance.toString(),
    purse: address,
    collectionId: String(nft.collection),
    itemIndex: nft.item,
  };
  // The runtime does not resolve this instance, so the NFT comes without a look.
  if (!display) return owned;

  const { name, imageUrl, tier, rare, metadata } = resolveDisplay(display);
  if (name) owned.name = name;
  if (imageUrl) owned.imageUrl = imageUrl;
  if (tier) owned.tier = tier;
  if (rare !== undefined) owned.rare = rare;
  if (metadata) owned.metadata = metadata;
  return owned;
}

/** What the grid keys an NFT by: its `hash` metadata as hex, or `instance-<id>` when it has none. */
function identityOf(nft: { instance: bigint }, display: FoundDisplay | undefined): string {
  const hash = display?.attributes[HASH_METADATA_KEY];
  return hash === undefined ? `instance-${nft.instance}` : metadataValueHex(hash);
}

/** The manifest CIDs that the NFTs state, each once and sorted, so the same NFTs give the same list. */
export function manifestCidsOf(nfts: OwnedNft[]): string[] {
  const cids = nfts.flatMap((nft) => {
    const cid = manifestCidOf(nft.metadata ?? {});
    return cid ? [cid] : [];
  });
  return [...new Set(cids)].sort();
}

/** Fetches the art manifest behind a CID. A manifest that arrived is kept, so it is fetched once. */
export function fetchArt(cid: string): Promise<FetchedManifest> {
  return readManifest(cid, IPFS_GATEWAY);
}

/** Puts the art manifests into the NFTs. An NFT whose manifest has not arrived yet shows its picture as pending. */
export function addArt(nfts: OwnedNft[], manifests: Manifests): OwnedNft[] {
  return nfts.map((nft) => {
    const attributes = nft.metadata ?? {};
    const cid = manifestCidOf(attributes);
    if (!cid) return nft;

    const fetched = manifests[cid];
    return fetched ? withManifest(nft, attributes, fetched) : { ...nft, artPending: true };
  });
}
