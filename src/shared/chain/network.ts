// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// The network this page runs on, read once from the name the host bound it
// under: `stash.paseo` runs on Paseo Next, `stash.testnet` on Previewnet.
// Previewnet's runtime is ahead of Paseo Next's, and every entry the app uses
// has the same type on both, so one set of generated types reads both; what
// differs is the genesis each descriptor carries, which is how the host is
// asked for a chain, and the name product-sdk-nfts keys its lists by.

import { paseoAssetHub, paseoPeople, previewnetAssetHub, previewnetPeople } from '@polkadot-api/descriptors';

import { DOTNS_IDENTIFIER } from './product';

/** A network name as `getChainAPI` and `getApprovedCollections` take it. */
export type NetworkName = 'paseo' | 'previewnet';

/** The network a DotNS name belongs to, by its TLD; anything else is read as
 *  paseo, the network the fallback name is on. */
export function networkOf(identifier: string): NetworkName {
  return identifier.toLowerCase().endsWith('.testnet') ? 'previewnet' : 'paseo';
}

export const NETWORK: NetworkName = networkOf(DOTNS_IDENTIFIER);

const descriptors = {
  paseo: { assetHub: paseoAssetHub, people: paseoPeople },
  previewnet: { assetHub: previewnetAssetHub, people: previewnetPeople },
} as const;

/** The descriptors of this network's chains: the paseo ones type every read,
 *  and each carries its own genesis. */
export const ASSET_HUB: typeof paseoAssetHub = descriptors[NETWORK].assetHub;
/** Previewnet's People runtime has one more `AsResources` variant in its signed
 *  extensions than Paseo Next's. The app signs nothing on People, so everything
 *  but the extensions is checked against the paseo types. */
const people: Omit<typeof paseoPeople, 'extensions'> = descriptors[NETWORK].people;
export const PEOPLE = people as typeof paseoPeople;

/** The Bulletin IPFS gateway of each network, asked for manifests and pictures
 *  beside the host's preimage lookup. */
const gateways: Record<NetworkName, string> = {
  paseo: 'https://paseo-bulletin-next-ipfs.polkadot.io',
  previewnet: 'https://previewnet.substrate.dev',
};

export const IPFS_GATEWAY = gateways[NETWORK];
