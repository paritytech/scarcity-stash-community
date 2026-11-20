// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// Shared test fixtures: well-known dev keypairs used across the chain
// read-path suites. Kept in one place so the SS58 encodings and the public
// key stay consistent (and correct) rather than being re-typed per file.

import type { Claimant } from '@parity/product-sdk-nfts';

// Alice, the canonical dev keypair, in two network prefixes plus its raw
// public key. The two SS58 forms decode to the same key: the fixture the
// prefix-independence tests (ss58, credits) lean on.
export const ALICE_42 = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY'; // substrate prefix
export const ALICE_0 = '15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5'; // polkadot prefix
export const ALICE_PUBKEY = '0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d';

// Bob: a second, distinct dev keypair, for "not this player" cases.
export const BOB_42 = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty';

/** Alice as a resolved account identity: the common claimant/signer subject. */
export const alice: Claimant = { tag: 'Account', address: ALICE_42 };
