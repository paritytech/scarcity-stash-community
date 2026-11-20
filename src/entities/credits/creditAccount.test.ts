// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as CreditAccountModule from './creditAccount';

const h = vi.hoisted(() => ({
  asks: [] as [string, number][],
  answer: 'ok',
  broken: false,
  player: null as string | null,
  tellPlayer: (): void => {},
}));
vi.mock('@/entities/player/identity', () => ({
  getPlayerAddress: () => h.player,
  subscribePlayer: (cb: (player: typeof h.player) => void) => {
    h.tellPlayer = () => cb(h.player);
    cb(h.player);
    return () => {};
  },
}));
vi.mock('@/shared/host/embed', () => ({ isInContainer: true }));
vi.mock('@/shared/chain/product', () => ({ DOTNS_IDENTIFIER: 'stash.paseo' }));
vi.mock('@parity/product-sdk-host', async () => {
  const { okAsync, errAsync } = await import('neverthrow');
  return {
    getAccountsProvider: async () => {
      if (h.broken) throw new Error('the transport closed');
      return {
        getProductAccount: (product: string, index: number) => {
          h.asks.push([product, index]);
          return h.answer === 'ok'
            ? okAsync({ publicKey: new Uint8Array(32).fill(5) })
            : errAsync(new Error('refused'));
        },
        getProductAccountSigner: (account: unknown, options: unknown) => ({ account, options }),
      };
    },
  };
});

import { JOLLITY_ACCOUNT_INDEX, jollityProductId } from './creditAccount';

let creditAccount: typeof CreditAccountModule.creditAccount;
let creditIdentity: typeof CreditAccountModule.creditIdentity;
let creditIdentityNow: typeof CreditAccountModule.creditIdentityNow;
let creditSigner: typeof CreditAccountModule.creditSigner;
let subscribeCanMint: typeof CreditAccountModule.subscribeCanMint;

// A fresh module per test, so no account stays asked for from the test before.
beforeEach(async () => {
  vi.resetModules();
  ({ creditAccount, creditIdentity, creditIdentityNow, creditSigner, subscribeCanMint } =
    await import('./creditAccount'));
});
afterEach(() => {
  h.asks = [];
  h.answer = 'ok';
  h.broken = false;
  h.player = null;
});

describe('creditAccount', () => {
  it("names Jollity on this site's network", () => {
    expect(jollityProductId('stash.paseo')).toBe('dim2.paseo');
    expect(jollityProductId('other.testnet')).toBe('dim2.testnet');
  });

  it("asks the host for Jollity's account at its sign-up index, once per session", async () => {
    const first = await creditAccount();
    await creditAccount();
    expect(h.asks).toEqual([['dim2.paseo', JOLLITY_ACCOUNT_INDEX]]);
    expect(first?.address).toMatch(/^5/);
    expect(await creditIdentity()).toEqual({ tag: 'Account', address: first!.address });
    expect(await creditSigner()).toEqual({ account: first!.account, options: { txExtVersion: 1 } });
  });

  it('asks again later when the host gave no account', async () => {
    h.answer = 'refused';
    expect(await creditAccount()).toBeNull();
    h.answer = 'ok';
    expect(await creditAccount()).not.toBeNull();
    expect(h.asks).toHaveLength(2);
  });

  it('returns null, never a rejection, when the host provider throws, and asks again later', async () => {
    h.broken = true;
    expect(await creditAccount()).toBeNull();
    expect(await creditSigner()).toBeNull();
    h.broken = false;
    expect(await creditAccount()).not.toBeNull();
  });

  it('returns at once without waiting on the host, and knows the account once the host has named it', async () => {
    expect(creditIdentityNow()).toBeNull();
    // The ask creditIdentityNow started is the one this awaits: the host is asked once.
    const found = await creditAccount();
    expect(h.asks).toEqual([['dim2.paseo', JOLLITY_ACCOUNT_INDEX]]);
    expect(creditIdentityNow()).toEqual({ tag: 'Account', address: found!.address });
  });
});

describe('subscribeCanMint', () => {
  const named = '5Player';

  it('turns minting on when a later ask names the account', async () => {
    h.player = named;
    h.answer = 'refused';
    const told: boolean[] = [];
    subscribeCanMint((canMint) => told.push(canMint));
    expect(await creditAccount()).toBeNull();
    expect(told.at(-1)).toBe(false);

    h.answer = 'ok';
    await creditAccount();
    expect(told.at(-1)).toBe(true);
  });

  it('keeps minting off until the player is named', async () => {
    const told: boolean[] = [];
    subscribeCanMint((canMint) => told.push(canMint));
    await creditAccount();
    expect(told.at(-1)).toBe(false);

    h.player = named;
    h.tellPlayer();
    expect(told.at(-1)).toBe(true);
  });
});
