// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// Whether the page runs inside a Polkadot host, and the app's own account there.

import { getAccountsProvider, isInsideContainerSync } from '@parity/product-sdk-host';

import { DOTNS_IDENTIFIER } from '@/shared/chain/product';
import { addressOfPublicKey } from '@/shared/chain/ss58';

export const isInContainer = typeof window !== 'undefined' && isInsideContainerSync();

/** The address of this app's product account 0, which names the player and
 *  holds the gas; null outside a host or before it has a session. */
export async function ownAccountAddress(): Promise<string | null> {
  const provider = await getAccountsProvider();
  if (!provider) return null;
  return provider.getProductAccount(DOTNS_IDENTIFIER, 0).match(
    (account) => addressOfPublicKey(account.publicKey),
    () => null,
  );
}
