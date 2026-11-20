// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AssetHubApi } from '@/shared/chain/client';

const PAYER = 'payer-0';
const PRODUCT = 'product-0';
const FEE = 100n;
const TRANSFER_FEE = 10n;

interface Hoisted {
  balances: Record<string, bigint>;
  allowance: string;
  allowanceGrants: bigint;
  requests: number;
  transfers: { amount: bigint }[];
  hostSigner: unknown;
}
const h = vi.hoisted((): Hoisted => ({
  balances: {},
  allowance: 'Allocated',
  allowanceGrants: 0n,
  requests: 0,
  transfers: [],
  hostSigner: { id: 'host' },
}));
vi.mock('@parity/product-sdk-host', () => ({
  requestResourceAllocation: vi.fn(async () => {
    h.requests++;
    if (h.allowance === 'Allocated') h.balances['product-0'] = (h.balances['product-0'] ?? 0n) + h.allowanceGrants;
    return { ok: true, value: [h.allowance] };
  }),
  formatHostError: (e: unknown) => String(e),
}));
vi.mock('@polkadot-api/descriptors', () => ({
  MultiAddress: { Id: (a: string) => ({ type: 'Id', value: a }) },
}));
vi.mock('@/shared/host/embed', () => ({ ownAccountAddress: async () => 'product-0' }));
vi.mock('@/shared/chain/signing', () => ({ hostProductSigner: async () => h.hostSigner }));
// The fake accounts are names, not SS58: compare them as names.
vi.mock('@/shared/chain/ss58', () => ({ sameAccount: (a: string, b: string) => a === b }));
vi.mock('@/shared/chain/submit', () => ({
  watchSubmission: vi.fn(async (tx: { args: { target: { value: string }; amount: bigint } }, signer: unknown) => {
    if (signer !== h.hostSigner) return { ok: false, error: 'wrong signer' };
    h.transfers.push({ amount: tx.args.amount });
    h.balances['product-0'] = (h.balances['product-0'] ?? 0n) - tx.args.amount - TRANSFER_FEE;
    h.balances[tx.args.target.value] = (h.balances[tx.args.target.value] ?? 0n) + tx.args.amount;
    return { ok: true };
  }),
}));

import { CLAIMS_PER_TOP_UP, ensureClaimGas, keepGasReady, READY_FLOOR_CLAIMS, waitForGasTopUp } from './gas';

const api = {
  constants: { Pgas: { PgasAssetId: async () => 2_000_000_000 } },
  query: {
    Assets: {
      Account: {
        getValue: async (_id: number, who: string) =>
          h.balances[who] === undefined ? undefined : { balance: h.balances[who] },
      },
    },
  },
  tx: {
    Assets: {
      transfer_keep_alive: (args: unknown) => ({
        args,
        getEstimatedFees: async () => TRANSFER_FEE,
      }),
    },
  },
} as unknown as AssetHubApi;

describe('ensureClaimGas', () => {
  beforeEach(() => {
    vi.stubGlobal('window', globalThis);
    h.balances = {};
    h.allowance = 'Allocated';
    h.allowanceGrants = 0n;
    h.requests = 0;
    h.transfers = [];
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('leaves a payer that can pay the fee alone', async () => {
    h.balances[PAYER] = FEE;
    expect(await ensureClaimGas(api, PAYER, { fee: FEE }, () => {})).toBeNull();
    expect(h.requests).toBe(0);
    expect(h.transfers).toHaveLength(0);
  });

  it('moves gas from a product account that holds enough, signed by the host, without asking the host for more', async () => {
    h.balances[PAYER] = 30n;
    h.balances[PRODUCT] = 1_000_000n;
    expect(await ensureClaimGas(api, PAYER, { fee: FEE }, () => {})).toBeNull();
    expect(h.requests).toBe(0);
    expect(h.transfers).toEqual([{ amount: FEE * CLAIMS_PER_TOP_UP - 30n }]);
    expect(h.balances[PAYER]).toBe(FEE * CLAIMS_PER_TOP_UP);
  });

  it("asks the host for the day's gas when the product account is short, then moves it", async () => {
    h.allowanceGrants = 500_000n;
    expect(await ensureClaimGas(api, PAYER, { fee: FEE }, () => {})).toBeNull();
    expect(h.requests).toBe(1);
    expect(h.transfers).toHaveLength(1);
    expect(h.balances[PAYER]).toBeGreaterThanOrEqual(FEE);
  });

  it('moves only what the product account can spare', async () => {
    h.balances[PRODUCT] = 150n; // below one top-up, above one fee and its own transfer fee
    h.allowance = 'Allocated';
    h.allowanceGrants = 0n; // the day's gas is already spent
    expect(await ensureClaimGas(api, PAYER, { fee: FEE }, () => {})).toBeNull();
    expect(h.transfers).toEqual([{ amount: 150n - 3n * TRANSFER_FEE }]);
  });

  it('reports why when the host cannot give gas', async () => {
    h.allowance = 'NotAvailable';
    const failure = await ensureClaimGas(api, PAYER, { fee: FEE }, () => {});
    expect(failure).toEqual({ kind: 'fee', detail: 'gas allowance NotAvailable' });
    expect(h.transfers).toHaveLength(0);
  });

  it("reports why when even the day's gas cannot cover the fee", async () => {
    h.allowanceGrants = 50n;
    const failure = await ensureClaimGas(api, PAYER, { fee: FEE }, () => {});
    expect(failure?.kind).toBe('fee');
    expect(h.transfers).toHaveLength(0);
  });

  it('warms product account 0 itself when it is the one signing the claim', async () => {
    h.allowanceGrants = 500_000n;
    expect(await ensureClaimGas(api, PRODUCT, { fee: FEE }, () => {})).toBeNull();
    expect(h.requests).toBe(1);
    expect(h.transfers).toHaveLength(0);
  });
});

describe('keepGasReady', () => {
  const fee = (): Promise<bigint> => Promise.resolve(FEE);
  beforeEach(() => {
    h.balances = { [PRODUCT]: 1_000_000n };
    h.allowance = 'Allocated';
    h.allowanceGrants = 0n;
    h.requests = 0;
    h.transfers = [];
  });

  it('tops an account up to 20 claims when it holds less than 3, even when one claim would pass', async () => {
    h.balances[PAYER] = FEE * 2n;
    await keepGasReady(api, PAYER, fee);
    expect(h.transfers).toEqual([{ amount: FEE * CLAIMS_PER_TOP_UP - FEE * 2n }]);
  });

  it('moves nothing when the product account has nothing to spare', async () => {
    h.balances[PAYER] = FEE * 2n;
    h.balances[PRODUCT] = 3n * TRANSFER_FEE; // all of it is the reserve for a transfer's fee
    await keepGasReady(api, PAYER, fee);
    expect(h.transfers).toHaveLength(0);
  });

  it('leaves an account with enough for 3 claims alone', async () => {
    h.balances[PAYER] = FEE * READY_FLOOR_CLAIMS;
    await keepGasReady(api, PAYER, fee);
    expect(h.transfers).toHaveLength(0);
    expect(h.requests).toBe(0);
  });

  it('runs one top-up for calls that overlap', async () => {
    await Promise.all([keepGasReady(api, PAYER, fee), keepGasReady(api, PAYER, fee)]);
    expect(h.transfers).toHaveLength(1);
  });

  it('lets a mint wait for the top-up that is running', async () => {
    let ended = false;
    const running = keepGasReady(api, PAYER, fee);
    void waitForGasTopUp().then(() => {
      ended = true;
    });
    await Promise.resolve();
    expect(ended).toBe(false);
    await running;
    await Promise.resolve();
    expect(ended).toBe(true);
    await expect(waitForGasTopUp()).resolves.toBeUndefined();
  });

  it('moves nothing and does not throw when the fee cannot be estimated', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(keepGasReady(api, PAYER, () => Promise.reject(new Error('no estimate')))).resolves.toBeUndefined();
    expect(h.transfers).toHaveLength(0);
    warn.mockRestore();
  });
});
