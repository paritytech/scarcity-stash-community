// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

import { paseoAssetHub, previewnetAssetHub } from '@polkadot-api/descriptors';
import { describe, expect, it } from 'vitest';

import { ASSET_HUB, IPFS_GATEWAY, NETWORK, networkOf } from './network';

describe('the network a name is on', () => {
  it('reads the TLD', () => {
    expect(networkOf('stash.paseo')).toBe('paseo');
    expect(networkOf('stash.testnet')).toBe('previewnet');
    expect(networkOf('my-fork.paseo')).toBe('paseo');
    expect(networkOf('localhost:5173')).toBe('paseo');
  });

  it('returns paseo for the fallback name, with paseo descriptors', () => {
    expect(NETWORK).toBe('paseo');
    expect(ASSET_HUB.genesis).toBe(paseoAssetHub.genesis);
    expect(ASSET_HUB.genesis).not.toBe(previewnetAssetHub.genesis);
    expect(IPFS_GATEWAY).toBe('https://paseo-bulletin-next-ipfs.polkadot.io');
  });
});
