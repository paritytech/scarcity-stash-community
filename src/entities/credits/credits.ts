// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// The credit read: every credit awarded to the player and where each stands.
// A credit is awarded on People into a tree whose root reaches Asset Hub, which
// verifies claims and records spent leaves in `ClaimedLeaves`. The read is the
// SDK's `getClaims`, mapped onto this app's types. Asset Hub removes a tree
// `NftClaims.TreeTtl` seconds after the tree's time, and its credits with it.

import type { Claim, Claimant } from '@parity/product-sdk-nfts';
import { getClaims, toClaimantKey } from '@parity/product-sdk-nfts';

import type { Credit, CreditWatch } from '@/entities/nfts/collectibles';
import type { AssetHubApi, ChainApis, PeopleApi } from '@/shared/chain/client';
import { nftsCreditsChain } from '@/shared/chain/nftsChain';
import { NEWEST, SHOW_AT } from '@/shared/chain/readAt';
import { normalizeHash } from '@/shared/lib/hash';

/** A tree still rootless this many People blocks on is finished and its root
 *  deleted; the SDK reads its credits as earned, here they count as claimed. */
const ROOT_GONE_AFTER = 300;

/** Every credit of this player, newest first, with its claim state and what to
 *  watch; `peopleSignature` is the People side at the read's block. */
export async function fetchClaims(
  apis: ChainApis,
  claimant: Claimant,
): Promise<ClaimsRead & { peopleSignature?: string }> {
  const chain = nftsCreditsChain(apis);
  if (!chain || !apis.people) throw new Error('no People Chain connection this session');
  const [result, treeTtl] = await Promise.all([
    getClaims(chain, { claimant, at: SHOW_AT, individualityAt: SHOW_AT }),
    apis.assetHub.constants.NftClaims.TreeTtl(),
  ]);
  // Callers expect a rejecting promise, not a Result.
  if (!result.ok) throw result.error;
  const { claims, at } = result.value;
  const read = toClaimsRead(claims, at.individuality.blockNumber, Number(treeTtl));
  const peopleSignature = await creditBlocksAt(
    apis.people,
    claimant,
    read.watch.rootless,
    at.individuality.blockHash,
  ).catch(() => undefined);
  return { ...read, ...(peopleSignature === undefined ? {} : { peopleSignature }) };
}

/** A credits read as the app takes it: the credits not spent yet, and what to
 *  watch for their next change. */
interface ClaimsRead {
  /** Each credit not spent yet, as the collectibles store keeps it. */
  credits: Credit[];
  watch: CreditWatch;
}

/** What the credits wait for, gathered while a read goes through them. */
interface Waiting {
  rootless: Set<number>;
  awaitingTree: Set<number>;
  unclaimed: Map<number, number[]>;
}

/** The credits of one claims read. `head` is the People block the read was
 *  made at, and `treeTtl` how many seconds a tree stays on Asset Hub. */
function toClaimsRead(claims: readonly Claim[], head: number, treeTtl: number): ClaimsRead {
  const credits: Credit[] = [];
  const waiting: Waiting = { rootless: new Set(), awaitingTree: new Set(), unclaimed: new Map() };
  for (const claim of claims) {
    if (isFinished(claim, head)) continue;
    noteWhatClaimWaitsFor(waiting, claim);
    // A block that lost its awards leaves no hash to show or spend.
    if (claim.hash !== null && claim.state !== 'claimed') credits.push(formatCredit(claim, claim.hash, treeTtl));
  }
  const watch: CreditWatch = {
    rootless: [...waiting.rootless],
    awaitingTree: [...waiting.awaitingTree],
    unclaimed: [...waiting.unclaimed].map(([block, leaves]) => ({ block, leaves })),
  };
  return { credits, watch };
}

/** Whether a rootless credit's tree is done: its award is older than a root
 *  stays, so every credit in it was minted or missed its deadline. */
const isFinished = (claim: Claim, head: number): boolean =>
  claim.awardedAt === null && claim.state === 'earned' && head - claim.awardBlock > ROOT_GONE_AFTER;

/** Notes what a credit waits for: its root, its tree on Asset Hub, or the claim of its leaf. */
function noteWhatClaimWaitsFor(waiting: Waiting, claim: Claim): void {
  if (claim.awardedAt === null) waiting.rootless.add(claim.awardBlock);
  else if (claim.state === 'earned') waiting.awaitingTree.add(claim.awardBlock);
  else if (claim.state === 'claimable' && claim.leafIndex !== null) {
    const leaves = waiting.unclaimed.get(claim.awardBlock) ?? [];
    leaves.push(claim.leafIndex);
    waiting.unclaimed.set(claim.awardBlock, leaves);
  }
}

/** A credit not spent yet, as the collectibles store keeps it. */
function formatCredit(claim: Claim, hash: string, treeTtl: number): Credit {
  const { leafIndex, proof } = claim;
  return {
    hash: normalizeHash(hash),
    awardBlock: claim.awardBlock,
    ...(claim.awardedAt === null ? {} : { awardedAt: claim.awardedAt, expiresAt: claim.awardedAt + treeTtl }),
    claimable: claim.state === 'claimable',
    ...(claim.state === 'claimable' && leafIndex !== null && proof !== null ? { leafIndex, proof } : {}),
  };
}

/** Whether the app mints from `credit` by itself at `now`, Unix milliseconds.
 *  The rule: half of the credit's lifetime is gone. */
export function isDueForMint(credit: Credit, now: number): boolean {
  const { awardedAt, expiresAt } = credit;
  return awardedAt !== undefined && expiresAt !== undefined && now / 1000 >= (awardedAt + expiresAt) / 2;
}

/** The People side of the player's credits at block `at`: the blocks holding
 *  them, and which of `rootless` have a root now. */
export async function creditBlocksAt(
  people: PeopleApi,
  claimant: Claimant,
  rootless: readonly number[],
  at: string,
): Promise<string> {
  const store = people.query.NftCredits;
  const [blocks, roots] = await Promise.all([
    store.NftClaimCreditBlocks.getValue(toClaimantKey(claimant), { at }),
    rootless.length === 0
      ? Promise.resolve([])
      : store.NftClaimCreditRoots.getValues(
          rootless.map((block) => [block] as [number]),
          { at },
        ),
  ]);
  return `${blocks.join(',')}/${roots.map((root) => (root === undefined ? '0' : '1')).join('')}`;
}

/** What `watch` waited for that has happened on Asset Hub by block `at`: empty
 *  while nothing has, null when it waits for nothing. */
export async function creditStateAt(assetHub: AssetHubApi, watch: CreditWatch, at: string): Promise<string | null> {
  if (watch.awaitingTree.length === 0 && watch.unclaimed.length === 0) return null;
  const store = assetHub.query.NftClaims;
  const [trees, bitmaps] = await Promise.all([
    watch.awaitingTree.length === 0
      ? Promise.resolve([])
      : store.CreditTrees.getValues(
          watch.awaitingTree.map((block) => [block] as [number]),
          { at },
        ),
    watch.unclaimed.length === 0
      ? Promise.resolve([])
      : store.ClaimedLeaves.getValues(
          watch.unclaimed.map(({ block }) => [block] as [number]),
          { at },
        ),
  ]);
  const happened: string[] = [];
  trees.forEach((tree, i) => {
    if (tree !== undefined) happened.push(`tree ${watch.awaitingTree[i]}`);
  });
  bitmaps.forEach((bitmap, i) => {
    const { block, leaves } = watch.unclaimed[i]!;
    for (const leaf of leaves) if (isClaimed(bitmap, leaf)) happened.push(`leaf ${block}:${leaf}`);
  });
  return happened.join(',');
}

/** Whether Asset Hub records the leaf as claimed at the newest block. Null when
 *  the bitmap could not be read. */
export async function isLeafClaimed(api: AssetHubApi, treeBlock: number, leafIndex: number): Promise<boolean | null> {
  try {
    // An absent entry is an empty bitmap: nothing in the tree has been claimed.
    const [bitmap] = await api.query.NftClaims.ClaimedLeaves.getValues([[treeBlock]], NEWEST);
    return isClaimed(bitmap ?? new Uint8Array(0), leafIndex);
  } catch {
    return null;
  }
}

/** Bit `leafIndex` of a `ClaimedLeaves` bitmap, least significant bit first. */
function isClaimed(bitmap: Uint8Array, leafIndex: number): boolean {
  const byte = bitmap[leafIndex >> 3];
  return byte !== undefined && ((byte >> (leafIndex & 7)) & 1) === 1;
}

/** The typed inclusion-proof entry `nft_claim_credit_proofs` returns. */
type ProofEntry = Extract<
  Awaited<ReturnType<PeopleApi['apis']['NftCreditsApi']['nft_claim_credit_proofs']>>,
  { success: true }
>['value'][number];

/** What a claim spends one credit with: the credit, its leaf index and the
 *  sibling hashes, typed as `NftClaims.claim` takes them. */
export interface ClaimProof {
  credit: ProofEntry['credit'];
  leafIndex: number;
  proof: ProofEntry['proof'];
}

/** The live proof of one credit. Null when the block holds no such credit for
 *  the player: pruned or never awarded. */
export async function fetchClaimProof(
  api: PeopleApi,
  claimant: Claimant,
  treeBlock: number,
  creditHash: string,
): Promise<ClaimProof | null> {
  const who = toClaimantKey(claimant);
  const result = await api.apis.NftCreditsApi.nft_claim_credit_proofs(treeBlock, who, NEWEST);
  if (!result.success) {
    console.warn(`[chain] no proofs for tree block ${treeBlock}:`, result.value.type);
    return null;
  }
  const lower = creditHash.toLowerCase();
  const target = lower.startsWith('0x') ? lower : `0x${lower}`;
  for (const entry of result.value) {
    if (entry.credit.toLowerCase() === target) {
      return { credit: entry.credit, leafIndex: entry.leaf_index, proof: entry.proof };
    }
  }
  return null;
}
