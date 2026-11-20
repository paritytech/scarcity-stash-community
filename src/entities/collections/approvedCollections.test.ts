// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

import { getApprovedCollections } from '@parity/product-sdk-nfts';
import { describe, expect, it } from 'vitest';

import { OFFERED_COLLECTIONS } from './approvedCollections';

describe('the offered collections', () => {
  it('are the ones the SDK approves for paseo, in its order', () => {
    expect([...OFFERED_COLLECTIONS]).toEqual([...getApprovedCollections('paseo')]);
    expect([...OFFERED_COLLECTIONS]).toEqual([27, 28, 26]);
  });

  it('are not empty on previewnet, where a new player holds only credits', () => {
    expect([...getApprovedCollections('previewnet')]).toEqual([0, 2, 1]);
  });
});
