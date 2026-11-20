// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// Content-address checks for Bulletin art. A CID is a hash of the content it
// names, so the CID the app already holds is what fetched bytes are checked
// against; the decoding lives in product-sdk-nfts.

import type { ImageRef } from '@parity/product-sdk-nfts';

/** An `ImageRef` for a CID string, with an empty `hex` so `artworkAddress`
 *  reads only the CID. */
export function imageRefOfCid(cid: string): ImageRef {
  return { hex: '0x', text: cid };
}
