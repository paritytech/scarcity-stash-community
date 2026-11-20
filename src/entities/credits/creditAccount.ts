// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// The account the credits are awarded to and claimed with: Jollity's playing
// account, Jollity's own product account at a fixed index. Jollity's manifest
// grants the Stash `context`, so the host signs a claim as that account once the
// person confirms. Credits awarded to the Stash's own product account are not read.

import { getAccountsProvider } from '@parity/product-sdk-host';
import type { Claimant } from '@parity/product-sdk-nfts';

import { getPlayerAddress, subscribePlayer } from '@/entities/player/identity';
import { DOTNS_IDENTIFIER } from '@/shared/chain/product';
import { type ChainSigner, HOST_PIPELINE } from '@/shared/chain/signer';
import { addressOfPublicKey } from '@/shared/chain/ss58';
import { isInContainer } from '@/shared/host/embed';
import { withDeadline } from '@/shared/lib/deadline';
import { createObservable } from '@/shared/lib/observable';

/** Jollity's DotNS label. Its TLD follows this site's network. */
const JOLLITY_LABEL = 'dim2';

/** The product account Jollity plays on and awards credits to: index 1, the
 *  lite key (`signupAccountIndex()` in Jollity's protocol package). */
export const JOLLITY_ACCOUNT_INDEX = 1;

/** How long the host may take to name the account. */
const ASK_MS = 15_000;

/** Jollity's product id on this site's network: dim2.paseo beside stash.paseo. */
export function jollityProductId(site: string = DOTNS_IDENTIFIER): string {
  const tld = site.split('.').pop() ?? '';
  return `${JOLLITY_LABEL}.${tld}`;
}

type Provider = NonNullable<Awaited<ReturnType<typeof getAccountsProvider>>>;
type ProductAccount = Parameters<Provider['getProductAccountSigner']>[0];

export interface CreditAccount {
  account: ProductAccount;
  /** SS58, prefix 42, like every address the app derives. */
  address: string;
}

let known: Promise<CreditAccount | null> | null = null;
/** The value `known` settled with, once it has. */
const resolved = createObservable<CreditAccount | null>(null);

/** Jollity's playing account, asked of the host once a session. Null outside a
 *  host or with nothing returned, which the next call asks again. Never rejects. */
export function creditAccount(): Promise<CreditAccount | null> {
  if (!isInContainer) return Promise.resolve(null);
  if (!known) {
    const asking = (async (): Promise<CreditAccount | null> => {
      const provider = await getAccountsProvider();
      if (!provider) return null;
      const account = await withDeadline(
        provider.getProductAccount(jollityProductId(), JOLLITY_ACCOUNT_INDEX).match(
          (a) => a,
          () => null,
        ),
        ASK_MS,
        "Jollity's account",
      ).catch(() => null);
      return account ? { account, address: addressOfPublicKey(account.publicKey) } : null;
    })().catch(() => null);
    known = asking;
    void asking.then((found) => {
      if (found) resolved.set(found);
      else if (known === asking) known = null;
    });
  }
  return known;
}

/** Jollity's account as a claimant if the host named it already, else null with
 *  the host asked in the background: for reads that must not wait, like a poll. */
export function creditIdentityNow(): Claimant | null {
  const found = resolved.get();
  if (!found) void creditAccount();
  return found ? { tag: 'Account', address: found.address } : null;
}

/** The credit account as a claimant. */
export async function creditIdentity(): Promise<Claimant | null> {
  const found = await creditAccount();
  return found ? { tag: 'Account', address: found.address } : null;
}

/** A signer for the credit account: the host signs as Jollity's account, which
 *  Jollity's grant allows and the person confirms. Never rejects. */
export async function creditSigner(): Promise<ChainSigner | null> {
  const found = await creditAccount();
  if (!found) return null;
  const provider = await getAccountsProvider().catch(() => null);
  return provider ? provider.getProductAccountSigner(found.account, HOST_PIPELINE) : null;
}

/** Whether this session can sign a claim now: the player is known, and so is
 *  Jollity's account. */
export const canMint = (): boolean => getPlayerAddress() !== null && resolved.get() !== null;

/** Calls `cb` now and on each change with whether this session can sign a
 *  claim. Returns an unsubscribe. */
export function subscribeCanMint(cb: (canMint: boolean) => void): () => void {
  const tell = (): void => cb(canMint());
  const stopPlayer = subscribePlayer(tell);
  const stopAccount = resolved.subscribe(tell);
  void creditAccount();
  return () => {
    stopPlayer();
    stopAccount();
  };
}
