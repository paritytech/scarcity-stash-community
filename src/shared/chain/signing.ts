// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// The host's signer for this site's own product accounts, used for the gas
// (gas.ts); claims are signed as Jollity's account (creditAccount.ts). Outside
// a host nothing signs, and the UI hides what needs a signature.

import { getAccountsProvider } from '@parity/product-sdk-host';

import { isInContainer } from '@/shared/host/embed';

import { DOTNS_IDENTIFIER } from './product';
import { type ChainSigner, HOST_PIPELINE } from './signer';

/** The host's signer for its product account `index`, or null outside a host
 *  or without the capability. It signs the claim gas top-up (gas.ts). */
export async function hostProductSigner(index: number): Promise<ChainSigner | null> {
  if (!isInContainer) return null;
  const provider = await getAccountsProvider();
  if (!provider) return null;
  const account = await provider.getProductAccount(DOTNS_IDENTIFIER, index).match(
    (a) => a,
    () => null,
  );
  return account ? provider.getProductAccountSigner(account, HOST_PIPELINE) : null;
}
