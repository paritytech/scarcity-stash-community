// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// Minting an NFT from a credit: `mintNftFromCredit` is the one function every
// mint calls. Mints run one after another, so each leases Jollity's nonce after
// the one before landed (credits/claim.ts). There is no batch claim: it would
// publicly tie a player's NFTs together. The app starts a mint by itself only
// from a due credit (`mintNftsFromDueCredits`).

import {
  type Claimant,
  type ClaimParams,
  type ClaimResult,
  getClaimProof,
  keepGasReadyForNextMint,
  leaseNonce,
  submitClaim,
  wasSpentBefore,
} from '@/entities/credits/claim';
import { canMint, creditIdentity, creditSigner, subscribeCanMint } from '@/entities/credits/creditAccount';
import { isDueForMint } from '@/entities/credits/credits';
import { waitForGasTopUp } from '@/entities/credits/gas';
import {
  type Collectible,
  type CollectiblesState,
  collectiblesStore,
  selectedCollectionItemOf,
  SESSION_STARTED_AT,
} from '@/entities/nfts/collectibles';
import { queryClient, stashPurseQuery } from '@/entities/nfts/queries';
import { createPurseAccount, HOST_ANSWER_DEADLINE_MS } from '@/entities/nfts/stashPurse';
import type { OwnedNft } from '@/entities/nfts/types';
import { getPlayerAddress, recordsOwner } from '@/entities/player/identity';
import { type ChainApis, getChainApis } from '@/shared/chain/client';
import { type FailureKind, fromThrown, PREFLIGHT } from '@/shared/chain/failure';
import { failResult } from '@/shared/chain/submit';
import { isInContainer } from '@/shared/host/embed';
import { withDeadline } from '@/shared/lib/deadline';
import { normalizeHash } from '@/shared/lib/hash';
import { journey, type JourneyHandle } from '@/shared/telemetry/log';

import { refreshChainSync } from './sync';

export type MintResult = { ok: true } | { ok: false; failure?: FailureKind };

/** How long the next due credit waits after a mint that failed. */
const MINT_PAUSE_MS = 60_000;

/** The mint running now, or the last one: the next one starts once it ends. */
let lastMint: Promise<unknown> = Promise.resolve();

/** Whether `mintNftsFromDueCredits` runs now. */
let mintingFromDueCredits = false;

/** Mints from due credits for the life of the page: when the records change
 *  and when the session becomes able to sign a claim. Outside a host there is
 *  no player, so nothing starts. */
export function startDueMints(): void {
  if (!isInContainer) return;
  collectiblesStore.subscribe((now, before) => {
    if (now.records !== before.records || now.selectionsRead !== before.selectionsRead) void mintNftsFromDueCredits();
  });
  subscribeCanMint(() => void mintNftsFromDueCredits());
}

/** Mints an NFT from each due credit, one after another. A failed mint is
 *  written on the credit's record, and the next credit follows MINT_PAUSE_MS
 *  later. */
async function mintNftsFromDueCredits(): Promise<void> {
  if (mintingFromDueCredits) return;
  mintingFromDueCredits = true;
  const findNext = (): ClaimParams | undefined => findDueCredit(collectiblesStore.getState(), Date.now());
  for (let due = findNext(); due; due = findNext()) {
    const result = await mintNftFromCredit(due);
    if (result.ok) continue;
    collectiblesStore.getState().mintFailed(due.credit, result.failure);
    // A failure can belong to the collection (`stuck` covers an owner change too),
    // so the next credit waits whatever the kind.
    await new Promise((resolve) => setTimeout(resolve, MINT_PAUSE_MS));
  }
  mintingFromDueCredits = false;
}

/** Whether the app's own mint from `record` failed in this session. */
const hasFailedThisSession = (record: Collectible): boolean =>
  record.mintFailedAt !== undefined && record.mintFailedAt >= SESSION_STARTED_AT;

/** The first due credit to mint from now, as a claim takes it: claimable, with
 *  the item of its collection read, and not failed in this session. None while
 *  the session cannot sign or the stored selections are not read. */
function findDueCredit(state: CollectiblesState, now: number): ClaimParams | undefined {
  if (!canMint() || !state.selectionsRead) return undefined;
  const records = state.order.flatMap((id) => state.records[id] ?? []);
  // `fee` and `notAllowed` fail every mint, and each mint creates an account first: no mint follows.
  const stopped = records.some(
    (r) => hasFailedThisSession(r) && (r.mintFailure === 'fee' || r.mintFailure === 'notAllowed'),
  );
  if (stopped) return undefined;
  for (const r of records) {
    if (r.type !== 'credit' || !r.credit?.claimable || !isDueForMint(r.credit, now)) continue;
    if (hasFailedThisSession(r) || r.selectedCollectionId === undefined || !selectedCollectionItemOf(r)?.item) continue;
    return { credit: r.credit.hash, awardBlock: r.credit.awardBlock, collection: Number(r.selectedCollectionId) };
  }
  return undefined;
}

/** Mints an NFT from the credit into a new account of the stash purse, after
 *  any mint still running. `credit` is its hash in any form. Never rejects. */
export async function mintNftFromCredit(params: ClaimParams): Promise<MintResult> {
  const turn = lastMint;
  let endTurn = (): void => {};
  lastMint = new Promise<void>((resolve) => (endTurn = resolve));
  await turn;
  const credit = `0x${normalizeHash(params.credit)}`;
  // One journey per mint, from here to the claim on the chain.
  const trace = journey('mint', { credit, collection: params.collection });
  trace.step('submitted');
  try {
    const result = await claimCredit({ ...params, credit }, trace);
    if (result.ok) {
      trace.done(mintedFacts(result));
      return { ok: true };
    }
    trace.fail(result.failure?.kind, result.failure?.detail ?? result.error ?? 'failed', {
      ...(result.error ? { detail: result.error } : {}),
      tx: result.tx,
      block: result.block,
      blockHash: result.blockHash,
    });
    return { ok: false, ...(result.failure ? { failure: result.failure.kind } : {}) };
  } catch (err) {
    console.error('[mint] could not be completed', err);
    const failure = fromThrown(err);
    trace.fail(failure.kind, failure.detail);
    return { ok: false, failure: failure.kind };
  } finally {
    endTurn();
  }
}

const mintedFacts = (result: ClaimResult) => ({
  ...(result.mintedTo ? { purse: result.mintedTo } : {}),
  ...(result.minted ? { instance: result.minted.instance, item: result.minted.item } : {}),
});

/** The chain side of a mint: Jollity's playing account spends the credit, the
 *  NFT goes to a new account of the stash purse and is stored at once. */
async function claimCredit(credit: ClaimParams, trace: JourneyHandle): Promise<ClaimResult> {
  const ready = await prepareMint();
  if (!('claimant' in ready)) return ready;
  const { apis, claimant } = ready;
  const proof = await getClaimProof(apis, claimant.address, credit, trace);
  if (!('leafIndex' in proof)) return proof;
  const purse = await withDeadline(queryClient.query(stashPurseQuery), HOST_ANSWER_DEADLINE_MS, 'the stash purse');
  if (purse.status !== 'ready') return failResult(PREFLIGHT.noPurses);
  const mintTo = await createPurseAccount(purse.id);
  trace.step('account created', { purse: mintTo });
  await waitForGasTopUp();
  const result = await submitClaim(apis, { ...credit, proof, mintTo }, claimant, trace);
  if (result.ok) {
    storeMintedNft(credit.credit, result);
    keepGasReadyForNextMint(apis, claimant.address);
  } else if (
    // A proof the chain rejected shows nothing about a spend.
    result.failure?.kind !== 'notReady' &&
    (await wasSpentBefore(apis, claimant.address, credit).catch(() => false))
  ) {
    trace.step('reconciled: already minted');
    collectiblesStore.getState().creditSpent(credit.credit);
    refreshChainSync();
    return { ok: true };
  }
  refreshChainSync();
  return result;
}

/** The connection and the claimant a mint needs, or the failure that stops it. */
async function prepareMint(): Promise<{ apis: ChainApis; claimant: Claimant } | ClaimResult> {
  if (!getPlayerAddress()) return failResult(PREFLIGHT.noIdentity);
  const apis = await getChainApis();
  if (!apis) return failResult(PREFLIGHT.noConnection);
  const claimant = await getJollityClaimant(apis);
  return claimant ? { apis, claimant } : failResult(PREFLIGHT.cannotSign);
}

/** Jollity's playing account as the claimant, which the credit names; its nonce
 *  is read now, while the rest of the mint gets ready. */
async function getJollityClaimant(apis: ChainApis): Promise<Claimant | null> {
  const identity = await creditIdentity();
  const signer = identity ? await creditSigner() : null;
  if (identity?.tag !== 'Account' || !signer) return null;
  return { address: identity.address, signer, nonce: leaseNonce(apis.assetHub, identity.address) };
}

/** Makes the credit's record the NFT the claim's event named, at once; with no
 *  NFT named, the NFT read brings it as a record of its own. */
function storeMintedNft(credit: string, result: ClaimResult): void {
  const store = collectiblesStore.getState();
  if (!result.minted || !result.mintedTo) {
    store.creditSpent(credit);
    return;
  }
  const { instance, collection, item } = result.minted;
  // A claim mints with no instance metadata, so the NFT's identity is its
  // instance, the same as in the NFT read (nfts/nfts.ts).
  const nft: OwnedNft = {
    hash: `instance-${instance}`,
    instance,
    purse: result.mintedTo,
    collectionId: String(collection),
    itemIndex: item,
  };
  store.minted(recordsOwner(), { credit, nft });
}
