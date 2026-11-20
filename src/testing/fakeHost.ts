// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// What the tests fake of the host's NFT purses.

import type { NftPurseItemKey } from '@parity/product-sdk-host';

/** An error the way the SDK throws a host's rejection. */
export function hostError(name: string) {
  return new Error(`nftPurse failed: ${name}`, { cause: { tag: name } });
}

/** The public key of account `n`. */
export const publicKey = (n: number): NftPurseItemKey => `0x${n.toString(16).padStart(64, '0')}`;
