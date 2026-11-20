// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// The one signer type every write takes: a polkadot-api 3 transaction
// creator, which signs a transaction's payload. The host's accounts provider
// returns it for a product account (signing.ts, credits/creditAccount.ts),
// asked to sign with transaction extension version 1 (HOST_PIPELINE).

import type { getTxCreator } from 'polkadot-api/tx-creator';

export type ChainSigner = ReturnType<typeof getTxCreator>;

/** The transaction extension version the host signs product accounts'
 *  transactions with: version 1 pays fees in PGAS; version 0, the default,
 *  charges PAS, which those accounts lack. */
export const HOST_PIPELINE = { txExtVersion: 1 } as const;
