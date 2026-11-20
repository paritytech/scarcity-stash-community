// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ gas: 'short' }));
vi.mock('./gas', () => ({
  ensureClaimGas: vi.fn(async () => {
    if (h.gas === 'throws') throw new Error('the gas read timed out');
    if (h.gas === 'moved') return null;
    return { kind: 'fee', detail: 'product account 0 holds 0 PGAS, the claim needs 1' };
  }),
}));

import type { AssetHubApi } from '@/shared/chain/client';
import type { ChainSigner } from '@/shared/chain/signer';
import { fakeAssetHub } from '@/testing/fakeChain';
import { ALICE_42 } from '@/testing/fixtures';

import { type Claim, leaseNonce, submitClaim } from './claim';
import { ensureClaimGas } from './gas';

type Apis = Parameters<typeof submitClaim>[0];
/** The credit's claim, minting into an account of the stash purse. */
const CLAIM: Claim = {
  credit: 'cafe',
  awardBlock: 10,
  collection: 2,
  proof: { credit: '0xCAFE', leafIndex: 3, proof: ['0xsib'] },
  mintTo: 'addr-0',
};
const claimantOn = (assetHub: AssetHubApi) => ({
  address: ALICE_42,
  signer: {} as ChainSigner,
  nonce: leaseNonce(assetHub, ALICE_42),
});
/** One claim of the credit on `assetHub`. */
const claimOn = (assetHub: AssetHubApi) => submitClaim({ assetHub } as unknown as Apis, CLAIM, claimantOn(assetHub));
/** How the pool rejects a transaction whose fee cannot be paid. */
const NO_FEE = { refuse: '{"type":"Invalid","value":{"type":"Payment"}}' };

afterEach(() => {
  vi.mocked(ensureClaimGas).mockClear();
  h.gas = 'short';
});

describe('a claim and its gas', () => {
  it('never touches the gas when the claim lands', async () => {
    const { api: assetHub } = fakeAssetHub();
    const res = await claimOn(assetHub);
    expect(res.ok).toBe(true);
    expect(ensureClaimGas).not.toHaveBeenCalled();
  });

  it('moves the gas over after the pool rejected the fee, then goes again once', async () => {
    h.gas = 'moved';
    const { api: assetHub, spies } = fakeAssetHub({ claimOutcomes: [NO_FEE] });
    const res = await claimOn(assetHub);
    expect(res).toMatchObject({ ok: true, mintedTo: CLAIM.mintTo });
    expect(ensureClaimGas).toHaveBeenCalledTimes(1);
    expect(spies.claimTx).toHaveBeenCalledTimes(1);
  });

  it('goes again only once when the pool keeps rejecting the fee', async () => {
    h.gas = 'moved';
    const { api: assetHub } = fakeAssetHub({ claimOutcomes: [NO_FEE, NO_FEE] });
    const res = await claimOn(assetHub);
    expect(res.failure?.kind).toBe('fee');
    expect(ensureClaimGas).toHaveBeenCalledTimes(1);
  });

  it('fails with the gas reason when the gas cannot move', async () => {
    const { api: assetHub } = fakeAssetHub({ claimOutcomes: [NO_FEE] });
    const res = await claimOn(assetHub);
    expect(res.failure).toEqual({ kind: 'fee', detail: 'product account 0 holds 0 PGAS, the claim needs 1' });
  });

  it('fails as transient, never a rejection, when the gas check throws', async () => {
    h.gas = 'throws';
    const { api: assetHub } = fakeAssetHub({ claimOutcomes: [NO_FEE] });
    const res = await claimOn(assetHub);
    expect(res.failure).toEqual({ kind: 'transient', detail: 'the gas read timed out' });
  });
});
