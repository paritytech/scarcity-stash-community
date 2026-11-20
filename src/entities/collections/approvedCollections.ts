// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// The collections a credit can mint into: the ones product-sdk-nfts approves
// for this network. Anyone can register a collection for claims; which ones to
// offer is a product decision kept in the SDK. NFTs from any collection still
// show on the grid.

import { getApprovedCollections } from '@parity/product-sdk-nfts';

import { NETWORK } from '@/shared/chain/network';

/** The ids this app offers, in the order the SDK lists them. */
export const OFFERED_COLLECTIONS: ReadonlySet<number> = new Set(getApprovedCollections(NETWORK));
