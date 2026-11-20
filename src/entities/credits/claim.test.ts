// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

import { Enum } from 'polkadot-api';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { collectiblesStore, type Credit, EMPTY_KEPT } from '@/entities/nfts/collectibles';
import type { AssetHubApi, ChainApis } from '@/shared/chain/client';
import type { ChainSigner } from '@/shared/chain/signer';
import { fakeAssetHub, fakeChainApis, fakePeople } from '@/testing/fakeChain';
import { ALICE_42 } from '@/testing/fixtures';

import { type Claimant, estimateClaimFee, getClaimProof, leaseNonce, submitClaim, wasSpentBefore } from './claim';
import type { ClaimProof } from './credits';

const signer = {} as ChainSigner;
/** The account of the stash purse the claim mints into. */
const MINT_TO = 'addr-0';
/** How the chain rejects a claim it cannot check. */
const INVALID = { type: 'Module', value: { type: 'NftClaims', value: { type: 'InvalidProof' } } };
const params = { credit: 'cafe', awardBlock: 10, collection: 2 };
/** The proof People gives for the credit: leaf 3 of the tree of block 10. */
const PROOF = { credit: '0xCAFE', leafIndex: 3, proof: ['0xsib'] };
const CLAIM = { ...params, proof: PROOF, mintTo: MINT_TO };
type Apis = Parameters<typeof submitClaim>[0];

/** Jollity's account on `assetHub`, with a nonce lease for its claims there. */
const claimantOn = (assetHub: AssetHubApi): Claimant => ({
  address: ALICE_42,
  signer,
  nonce: leaseNonce(assetHub, ALICE_42),
});
/** A session over `assetHub` alone: a claim with its proof in hand reads nothing else. */
const sessionOf = (assetHub: AssetHubApi): Apis => ({ assetHub }) as unknown as Apis;

/** The credits a read brought, as their records keep them, proofs included. */
const readCredits = (credits: Credit[]): void => collectiblesStore.getState().readCredits('', credits, null);
const claimable = (hash: string, leafIndex: number, proof: string[]): Credit => ({
  hash,
  awardBlock: 10,
  claimable: true,
  leafIndex,
  proof,
});

const proofFor = (block: number) =>
  new Map<number, { success: boolean; value: unknown }>([
    [block, { success: true, value: [{ credit: '0xCAFE', leaf: '0x', leaf_index: 3, proof: ['0xsib'] }] }],
  ]);

/** The credit's proof, as getClaimProof gives it, or a failed test. */
async function proofOf(apis: ChainApis): Promise<ClaimProof> {
  const proof = await getClaimProof(apis, ALICE_42, params);
  if (!('leafIndex' in proof)) throw new Error(proof.error);
  return proof;
}

afterEach(() => {
  collectiblesStore.setState(EMPTY_KEPT);
});

describe('submitClaim', () => {
  it('does not go again for any other rejection', async () => {
    const { api: assetHub, spies } = fakeAssetHub({
      claimOutcomes: [{ ok: false, dispatchError: INVALID }],
    });
    const res = await submitClaim(sessionOf(assetHub), CLAIM, claimantOn(assetHub));
    expect(res.ok).toBe(false);
    expect(spies.claimTx).toHaveBeenCalledTimes(1);
  });

  it("reads no claimed bit: rejecting a spent credit is the chain's job", async () => {
    const ALREADY = { type: 'Module', value: { type: 'NftClaims', value: { type: 'AlreadyClaimed' } } };
    const { api: assetHub, spies } = fakeAssetHub({
      claimedLeaves: new Map([[10, new Uint8Array([0b0000_1000])]]),
      claimOutcomes: [{ ok: false, dispatchError: ALREADY }],
    });
    const res = await submitClaim(sessionOf(assetHub), CLAIM, claimantOn(assetHub));
    expect(res.failure?.kind).toBe('alreadyDone');
    expect(spies.claimedLeaves).not.toHaveBeenCalled();
    expect(spies.claimTx).toHaveBeenCalledTimes(1);
  });

  it("names the minted NFT from the claim's event", async () => {
    const claimed = {
      type: 'NftClaims',
      value: { type: 'CreditClaimed', value: { block: 10, collection: 2, item: 5, owner: 'addr-1', instance: 42n } },
    };
    const { api: assetHub } = fakeAssetHub({ claimOutcomes: [{ ok: true, events: [claimed] }] });
    const res = await submitClaim(sessionOf(assetHub), CLAIM, claimantOn(assetHub));
    expect(res.minted).toEqual({ instance: '42', collection: 2, item: 5, owner: 'addr-1' });
  });

  it('builds NftClaims.claim from the proof and the account it was given, and resolves ok', async () => {
    const { api: assetHub, spies } = fakeAssetHub();

    const res = await submitClaim(sessionOf(assetHub), CLAIM, claimantOn(assetHub));

    expect(res).toMatchObject({ ok: true, mintedTo: MINT_TO });
    expect(spies.claimTx).toHaveBeenCalledTimes(1);
    expect(spies.claimTx.mock.calls[0]![0]).toEqual({
      claimant: Enum('Account'),
      block: 10,
      credit: '0xCAFE', // echoed from the proof, not the raw param
      leaf_index: 3,
      proof: ['0xsib'],
      collection: 2,
      mint_to: MINT_TO,
    });
  });
});

describe('getClaimProof', () => {
  it('fails when the credits chain is unreachable', async () => {
    const { api: assetHub } = fakeAssetHub();
    const res = await getClaimProof(fakeChainApis(assetHub, null), ALICE_42, params);
    const detail = "can't reach the credits chain to prove this claim";
    expect(res).toEqual({ ok: false, error: detail, failure: { kind: 'transient', detail } });
  });

  it('fails when no inclusion proof exists for the credit', async () => {
    const { api: assetHub } = fakeAssetHub();
    const res = await getClaimProof(fakeChainApis(assetHub, fakePeople().api), ALICE_42, params);
    const detail = 'no claim proof for this credit yet';
    expect(res).toEqual({ ok: false, error: detail, failure: { kind: 'notReady', detail } });
  });

  it("takes the proof the credit's record keeps, without asking People", async () => {
    readCredits([claimable('cafe', 3, ['0xsib'])]);
    const people = fakePeople();
    const { api: assetHub } = fakeAssetHub();
    expect(await proofOf(fakeChainApis(assetHub, people.api))).toEqual({
      credit: '0xcafe',
      leafIndex: 3,
      proof: ['0xsib'],
    });
    expect(people.spies.proofs).not.toHaveBeenCalled();
  });

  it('asks People for the proof of a credit whose record has none', async () => {
    readCredits([{ hash: 'cafe', awardBlock: 10, claimable: true }, claimable('beef', 4, ['0xsib'])]);
    const people = fakePeople({ proofs: proofFor(10) });
    const { api: assetHub } = fakeAssetHub();
    expect(await proofOf(fakeChainApis(assetHub, people.api))).toMatchObject({ leafIndex: 3 });
    expect(people.spies.proofs).toHaveBeenCalledTimes(1);
  });

  it('asks People again after the chain rejected a kept proof', async () => {
    readCredits([claimable('cafe', 3, ['0xstale'])]);
    const people = fakePeople({ proofs: proofFor(10) });
    const { api: assetHub } = fakeAssetHub({ claimOutcomes: [{ ok: false, dispatchError: INVALID }] });
    const apis = fakeChainApis(assetHub, people.api);
    const claimant = claimantOn(assetHub);
    const stale = await proofOf(apis);
    expect((await submitClaim(apis, { ...params, proof: stale, mintTo: MINT_TO }, claimant)).failure?.kind).toBe(
      'notReady',
    );
    const fresh = await proofOf(apis);
    expect((await submitClaim(apis, { ...params, proof: fresh, mintTo: MINT_TO }, claimant)).ok).toBe(true);
    expect(people.spies.proofs).toHaveBeenCalledTimes(1);
  });
});

describe('a claim with a leased nonce', () => {
  /** How the pool rejects a transaction whose nonce the chain has moved past. */
  const STALE = { refuse: '{"type":"Invalid","value":{"type":"Stale"}}' };
  /** How the pool rejects a transaction whose fee cannot be paid. */
  const NO_FEE = { refuse: '{"type":"Invalid","value":{"type":"Payment"}}' };

  /** One claim, signed with `claimant`'s lease. */
  const claimWith = (assetHub: AssetHubApi, claimant: Claimant) => submitClaim(sessionOf(assetHub), CLAIM, claimant);

  it('signs with the leased nonce and never asks the chain for one', async () => {
    const { api: assetHub, spies } = fakeAssetHub({ nonce: 5 });
    const claimant = claimantOn(assetHub);
    const res = await claimWith(assetHub, claimant);
    expect(res.ok).toBe(true);
    expect(spies.submitOptions).toEqual([{ nonce: 5 }]);
    expect(spies.accountNonce).toHaveBeenCalledTimes(1);
    // The claim landed: the next claim takes the following nonce.
    expect(await claimant.nonce.next()).toBe(6);
  });

  it('signs with no nonce when the lease could not read one', async () => {
    const { api: assetHub, spies } = fakeAssetHub();
    spies.accountNonce.mockRejectedValue(new Error('smoldot is away'));
    expect((await claimWith(assetHub, claimantOn(assetHub))).ok).toBe(true);
    expect(spies.submitOptions).toEqual([{ nonce: undefined }]);
  });

  it('keeps the nonce for a claim the pool rejected before any block', async () => {
    const { api: assetHub, spies } = fakeAssetHub({ nonce: 5, claimOutcomes: [NO_FEE, NO_FEE] });
    const claimant = claimantOn(assetHub);
    // The fake chain charges nothing, so the gas check passes and the claim
    // goes again once: rejected twice, it spent no nonce either time.
    const res = await claimWith(assetHub, claimant);
    expect(res.failure?.kind).toBe('fee');
    expect(spies.submitOptions).toEqual([{ nonce: 5 }, { nonce: 5 }]);
    expect(await claimant.nonce.next()).toBe(5);
  });

  it('reads the nonce again and goes once more when the pool calls it stale', async () => {
    const { api: assetHub, spies } = fakeAssetHub({ nonce: 5, claimOutcomes: [STALE] });
    spies.accountNonce.mockResolvedValueOnce(5).mockResolvedValueOnce(9);
    const res = await claimWith(assetHub, claimantOn(assetHub));
    expect(res.ok).toBe(true);
    expect(spies.accountNonce).toHaveBeenCalledTimes(2);
    expect(spies.submitOptions).toEqual([{ nonce: 5 }, { nonce: 9 }]);
  });

  it('gives up with the rejection when the pool marks the nonce stale twice', async () => {
    const { api: assetHub, spies } = fakeAssetHub({ nonce: 5, claimOutcomes: [STALE, STALE] });
    const res = await claimWith(assetHub, claimantOn(assetHub));
    expect(res.ok).toBe(false);
    expect(res.failure?.detail).toContain('Stale');
    expect(spies.submitOptions).toHaveLength(2);
  });
});

describe('leaseNonce', () => {
  /** An Asset Hub whose nonce read returns each value in turn, or rejects. */
  function nonceApi(answers: (number | Error)[]) {
    const queue = [...answers];
    const accountNonce = vi.fn(async () => {
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return next;
    });
    return {
      api: { apis: { AccountNonceApi: { account_nonce: accountNonce } } } as unknown as AssetHubApi,
      accountNonce,
    };
  }

  it('reads once and counts up for every claim that landed', async () => {
    const { api, accountNonce } = nonceApi([7]);
    const lease = leaseNonce(api, 'jollity');
    expect(await lease.next()).toBe(7);
    // Two claims land.
    lease.landed();
    lease.landed();
    expect(await lease.next()).toBe(9);
    expect(accountNonce).toHaveBeenCalledTimes(1);
  });

  it('starts over from a fresh read when asked to read again', async () => {
    const { api, accountNonce } = nonceApi([7, 12]);
    const lease = leaseNonce(api, 'jollity');
    lease.landed();
    // The chain rejects the nonce; the lease reads again.
    lease.reread();
    expect(await lease.next()).toBe(12);
    expect(accountNonce).toHaveBeenCalledTimes(2);
  });

  it('returns nothing when the read failed, so the signer asks the chain itself', async () => {
    const { api } = nonceApi([new Error('smoldot is away')]);
    const lease = leaseNonce(api, 'jollity');
    lease.landed();
    expect(await lease.next()).toBeUndefined();
  });
});

describe('wasSpentBefore', () => {
  // The proof's leaf is 3: bit 3 of the tree's bitmap.
  const claimedLeaf3 = new Map([[10, new Uint8Array([0b0000_1000])]]);

  it("is true when Asset Hub's claimed bit for the credit's leaf is set", async () => {
    const people = fakePeople({ proofs: proofFor(10) }).api;
    const { api: assetHub } = fakeAssetHub({ claimedLeaves: claimedLeaf3 });
    expect(await wasSpentBefore(fakeChainApis(assetHub, people), ALICE_42, params)).toBe(true);
  });

  it('is false while the bit is clear, although the proof is still there', async () => {
    const people = fakePeople({ proofs: proofFor(10) }).api;
    const { api: assetHub } = fakeAssetHub({
      claimedLeaves: new Map([[10, new Uint8Array([0b0000_0111])]]),
    });
    expect(await wasSpentBefore(fakeChainApis(assetHub, people), ALICE_42, params)).toBe(false);
  });

  it('is false without a proof: a pruned or unknown credit is no evidence of a spend', async () => {
    const people = fakePeople().api; // no proofs
    const { api: assetHub } = fakeAssetHub({ claimedLeaves: claimedLeaf3 });
    expect(await wasSpentBefore(fakeChainApis(assetHub, people), ALICE_42, params)).toBe(false);
  });
});

describe('estimateClaimFee', () => {
  it('estimates the claim of a credit from its kept proof, without signing', async () => {
    readCredits([claimable('cafe', 3, ['0xsib'])]);
    const { api, spies } = fakeAssetHub();

    await expect(estimateClaimFee(api, 'payer', { credit: 'cafe', awardBlock: 10 })).resolves.toBe(0n);

    expect(spies.claimTx).toHaveBeenCalledWith({
      claimant: Enum('Account'),
      block: 10,
      credit: '0xcafe',
      leaf_index: 3,
      proof: ['0xsib'],
      collection: 0,
      mint_to: 'payer',
    });
    expect(spies.submitOptions).toHaveLength(0);
  });

  it('fails for a credit whose proof is not kept', async () => {
    const { api } = fakeAssetHub();
    await expect(estimateClaimFee(api, 'payer', { credit: 'cafe', awardBlock: 10 })).rejects.toThrow('no kept proof');
  });
});
