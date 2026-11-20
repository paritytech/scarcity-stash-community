// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// The chain call `NftClaims.claim`, signed by Jollity's playing account
// (creditAccount.ts), mints an NFT with a credit into the account the caller
// gives. A credit on the grid carries its proof from the credit read; one
// without asks People for it. A claim rejected for its fee or its nonce goes
// again once, after the gas moves or the nonce is read again.

import { Enum } from 'polkadot-api';
import { getFakeTxCreator } from 'polkadot-api/tx-creator';

import { collectiblesStore, recordOfCredit } from '@/entities/nfts/collectibles';
import type { AssetHubApi, ChainApis } from '@/shared/chain/client';
import { fromThrown, PREFLIGHT, type WriteFailure } from '@/shared/chain/failure';
import { NEWEST } from '@/shared/chain/readAt';
import type { ChainSigner } from '@/shared/chain/signer';
import { type ChainEvent, failResult, type SubmitResult, watchSubmission } from '@/shared/chain/submit';
import { withDeadline } from '@/shared/lib/deadline';
import type { JourneyHandle } from '@/shared/telemetry/log';
import { statusStep } from '@/shared/telemetry/steps';

import { type ClaimProof, fetchClaimProof, isLeafClaimed } from './credits';
import { ensureClaimGas, keepGasReady } from './gas';

/** How long each read before a claim's submission may take. */
const PREPARE_MS = 20_000;

/** The credit a claim spends, the People block it was awarded in (which names
 *  the tree its proof verifies against), and the chosen collection. */
export interface ClaimParams {
  credit: string;
  awardBlock: number;
  collection: number;
}

/** Everything `NftClaims.claim` carries: the credit, its proof, and the
 *  account the NFT is minted into. */
export interface Claim extends ClaimParams {
  proof: ClaimProof;
  mintTo: string;
}

/** Who signs a claim: Jollity's playing account, the signer the host gives
 *  for it, and the nonce leased for this mint. */
export interface Claimant {
  address: string;
  signer: ChainSigner;
  nonce: NonceLease;
}

// How long signing, moving the day's gas, and showing the minted NFT may take
// before the journey records a stall.
const SIGN_BUDGET_MS = 120_000;
const GAS_BUDGET_MS = 120_000;
const SHOWN_BUDGET_MS = 60_000;

/** The NFT a landed claim minted, as its `CreditClaimed` event names it. */
interface MintedNft {
  instance: string;
  collection: number;
  item: number;
  /** The account it was minted to, in the chain's own address form. */
  owner?: string;
}

/** The submission's outcome and, once it lands, the account minted into and
 *  the NFT its events name. */
export type ClaimResult = SubmitResult & { mintedTo?: string; minted?: MintedNft };

/** The NFT a landed claim minted, read from its events. */
function mintedBy(events: readonly ChainEvent[] | undefined): MintedNft | null {
  for (const event of events ?? []) {
    if (event.type !== 'NftClaims' || event.value.type !== 'CreditClaimed') continue;
    const fields = event.value.value as {
      instance?: bigint | number;
      collection?: number;
      item?: number;
      owner?: unknown;
    };
    if (fields.instance === undefined) continue;
    return {
      instance: fields.instance.toString(),
      collection: Number(fields.collection),
      item: Number(fields.item),
      ...(typeof fields.owner === 'string' ? { owner: fields.owner } : {}),
    };
  }
  return null;
}

/** The claim of one credit, as a transaction still to sign. */
function claimCall(api: AssetHubApi, claim: Claim) {
  return api.tx.NftClaims.claim({
    claimant: Enum('Account'),
    block: claim.awardBlock,
    credit: claim.proof.credit,
    leaf_index: claim.proof.leafIndex,
    proof: claim.proof.proof,
    collection: claim.collection,
    mint_to: claim.mintTo,
  });
}

/** What a claim costs `payer`, estimated unsigned from the credit's kept proof,
 *  with placeholders the size of the real collection and account. */
export async function estimateClaimFee(
  api: AssetHubApi,
  payer: string,
  credit: Pick<ClaimParams, 'credit' | 'awardBlock'>,
): Promise<bigint> {
  const proof = keptProof(credit.credit);
  if (!proof) throw new Error('no kept proof to estimate a claim with');
  return claimCall(api, { ...credit, collection: 0, proof, mintTo: payer }).getEstimatedFees(getFakeTxCreator(payer));
}

/** Signs and watches a claim to inclusion. Never rejects. It signs with the
 *  leased nonce, so the signer asks the chain for none. */
export async function submitClaim(
  apis: ChainApis,
  claim: Claim,
  claimant: Claimant,
  trace?: JourneyHandle,
): Promise<ClaimResult> {
  const { nonce } = claimant;
  const tx = claimCall(apis.assetHub, claim);
  // A claim that reached a block spent its nonce, even if it failed there.
  const submit = async (): Promise<SubmitResult> => {
    const result = await watchSubmission(
      tx,
      claimant.signer,
      (s, facts) => {
        if (s === 'signing') trace?.step('signature asked', facts, SIGN_BUDGET_MS);
        else trace?.step(statusStep(s), facts, SHOWN_BUDGET_MS);
      },
      { nonce: await nonce.next() },
    );
    if (result.block !== undefined) nonce.landed();
    return result;
  };

  let result = await submit();
  // Stale: another app moved the nonce on. Future: a counted claim never
  // landed. A fresh read fixes either.
  const refusal = result.failure?.detail ?? '';
  if (!result.ok && /"(Stale|Future)"/.test(refusal)) {
    trace?.step('refused for nonce', { detail: refusal }, SIGN_BUDGET_MS);
    nonce.reread();
    result = await submit();
  }
  if (!result.ok && result.failure?.kind === 'fee') {
    trace?.step('refused for gas', { detail: result.failure.detail }, GAS_BUDGET_MS);
    const estimate = (): Promise<bigint> => tx.getEstimatedFees(getFakeTxCreator(claimant.address));
    const noGas = await topUpForClaim(apis, claimant.address, estimate, trace);
    if (noGas) return failResult(noGas);
    result = await submit();
  }
  if (result.ok) {
    const minted = mintedBy(result.events);
    return { ...result, mintedTo: claim.mintTo, ...(minted ? { minted } : {}) };
  }
  // A proof the chain rejected is asked for afresh next time.
  if (result.failure?.kind === 'notReady') collectiblesStore.getState().proofRefused(claim.credit);
  return result;
}

/** The proof the credit's record keeps from the credits read, if any. */
function keptProof(credit: string): ClaimProof | undefined {
  const kept = recordOfCredit(collectiblesStore.getState(), credit)?.credit;
  if (kept?.leafIndex === undefined || !kept.proof) return undefined;
  return {
    credit: `0x${kept.hash}` as ClaimProof['credit'],
    leafIndex: kept.leafIndex,
    proof: kept.proof,
  };
}

/** The proof a claim spends: the one the credit's record keeps, else a fresh
 *  one from People, else the claim's failure. */
export async function getClaimProof(
  apis: ChainApis,
  claimant: string,
  credit: Pick<ClaimParams, 'credit' | 'awardBlock'>,
  trace?: JourneyHandle,
): Promise<ClaimProof | ClaimResult> {
  const kept = keptProof(credit.credit);
  if (kept) {
    trace?.step('proof kept', { block: credit.awardBlock }, PREPARE_MS);
    return kept;
  }
  if (!apis.people) return failResult(PREFLIGHT.noCreditsChain);
  let proof: ClaimProof | null;
  try {
    proof = await withDeadline(
      fetchClaimProof(apis.people, { tag: 'Account', address: claimant }, credit.awardBlock, credit.credit),
      PREPARE_MS,
      'the claim proof',
    );
  } catch (err) {
    return failResult(fromThrown(err));
  }
  // No proof may mean the root has not landed; it never means the credit is spent.
  if (!proof) return failResult(PREFLIGHT.noProof);
  trace?.step('proof fetched', { block: credit.awardBlock }, PREPARE_MS);
  return proof;
}

/** Whether the credit is spent although this claim failed, by an earlier claim
 *  that landed unseen or by another app. Reads Asset Hub's claimed bit. */
export async function wasSpentBefore(
  apis: ChainApis,
  claimant: string,
  credit: Pick<ClaimParams, 'credit' | 'awardBlock'>,
): Promise<boolean> {
  const proof = await getClaimProof(apis, claimant, credit);
  if (!('leafIndex' in proof)) return false;
  return (await isLeafClaimed(apis.assetHub, credit.awardBlock, proof.leafIndex)) === true;
}

/** Move the day's gas into the claim's payer after the pool rejected the claim
 *  for its fee. Null once the payer holds enough for it; else why it cannot. */
async function topUpForClaim(
  apis: ChainApis,
  payer: string,
  estimate: () => Promise<bigint>,
  trace?: JourneyHandle,
): Promise<WriteFailure | null> {
  const fee = await withDeadline(Promise.resolve().then(estimate), PREPARE_MS, 'the fee estimate').catch(() => null);
  if (fee === null) return { kind: 'transient', detail: "the claim's fee could not be estimated" };
  const gasFrom = Date.now();
  // The top-up's steps are named apart, so the journey shows which one waited.
  const noGas = await ensureClaimGas(apis.assetHub, payer, { fee }, (s, facts) => {
    trace?.step(`gas top-up ${s}`, facts, GAS_BUDGET_MS);
  }).catch((err: unknown) => fromThrown(err));
  if (!noGas) trace?.step('gas checked', { ms: Date.now() - gasFrom }, SIGN_BUDGET_MS);
  return noGas;
}

/** Moves the gas for the next mint ahead of it (gas.ts): while a credit waits
 *  with its proof, Jollity's account is topped up when it runs low. */
export function keepGasReadyForNextMint(apis: ChainApis, payer: string): void {
  const waiting = Object.values(collectiblesStore.getState().records).find(
    (record) => record.type === 'credit' && record.credit?.claimable && record.credit.proof,
  )?.credit;
  if (!waiting) return;
  void keepGasReady(apis.assetHub, payer, () =>
    estimateClaimFee(apis.assetHub, payer, { credit: waiting.hash, awardBlock: waiting.awardBlock }),
  );
}

/** One mint's nonce, read once instead of on every signature. `next` returns
 *  undefined when the read failed, and the signer then asks the chain itself. */
export interface NonceLease {
  next(): Promise<number | undefined>;
  /** A claim landed, with this nonce: the next one takes the following. */
  landed(): void;
  /** The chain rejected the nonce (another surface moved it): read it again. */
  reread(): void;
}

/** Leases `who`'s nonce from the newest block. Never rejects. */
export function leaseNonce(api: AssetHubApi, who: string): NonceLease {
  const read = async (): Promise<number | undefined> =>
    api.apis.AccountNonceApi.account_nonce(who, NEWEST).catch(() => undefined);
  let reading = read();
  let used = 0;
  return {
    next: async () => {
      const nonce = await reading;
      return nonce === undefined ? undefined : nonce + used;
    },
    landed: () => {
      used++;
    },
    reread: () => {
      reading = read();
      used = 0;
    },
  };
}
