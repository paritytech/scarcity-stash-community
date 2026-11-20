// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// Gas for a claim, from the person's daily People Gas. A claim's signer pays in
// PGAS when it holds the fee, else in PAS, and PGAS only with transaction
// extension version 1 (HOST_PIPELINE in signer.ts). The signer is Jollity's
// account, which nobody funds, so before a claim it gets PGAS moved over from
// the Stash's product account 0, where the host claims the person's daily
// PGAS when asked.

import { formatHostError, requestResourceAllocation } from '@parity/product-sdk-host';
import { MultiAddress } from '@polkadot-api/descriptors';
import { getFakeTxCreator } from 'polkadot-api/tx-creator';

import type { AssetHubApi } from '@/shared/chain/client';
import type { WriteFailure } from '@/shared/chain/failure';
import { NEWEST } from '@/shared/chain/readAt';
import { hostProductSigner } from '@/shared/chain/signing';
import { sameAccount } from '@/shared/chain/ss58';
import { type OnSubmitStatus, watchSubmission } from '@/shared/chain/submit';
import { ownAccountAddress } from '@/shared/host/embed';
import { withDeadline } from '@/shared/lib/deadline';

/** The product account the host claims the person's daily PGAS into. */
const GAS_ACCOUNT_INDEX = 0;
/** How many claims one top-up covers, so a day of mints asks the host once. */
export const CLAIMS_PER_TOP_UP = 20n;
/** The host proves personhood and claims on chain before it returns. */
const ALLOWANCE_DEADLINE_MS = 90_000;
/** How long a moved balance may take to show at the newest block. */
const SETTLE_ATTEMPTS = 8;
const SETTLE_MS = 1_500;

const noGas = (detail: string): WriteFailure => ({ kind: 'fee', detail });

async function pgasOf(api: AssetHubApi, assetId: number, who: string): Promise<bigint> {
  const account = await api.query.Assets.Account.getValue(assetId, who, NEWEST);
  return account?.balance ?? 0n;
}

/** Ask the host to claim the person's daily PGAS into product account 0. */
async function requestDailyGas(): Promise<WriteFailure | null> {
  const request = requestResourceAllocation([
    { tag: 'SmartContractAllowance', value: { tag: 'Index', value: GAS_ACCOUNT_INDEX } },
  ]);
  const answer = await withDeadline(request, ALLOWANCE_DEADLINE_MS, 'gas allowance').catch((err: unknown) => ({
    ok: false as const,
    error: err,
  }));
  if (!answer.ok) return noGas(`gas allowance failed: ${formatHostError(answer.error)}`);
  const outcome = answer.value[0];
  return outcome === 'Allocated' ? null : noGas(`gas allowance ${outcome ?? 'missing'}`);
}

/** Whether `who` holds at least `fee` PGAS, read again while a move settles. */
async function settled(api: AssetHubApi, assetId: number, who: string, fee: bigint): Promise<boolean> {
  for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt++) {
    if ((await pgasOf(api, assetId, who)) >= fee) return true;
    await new Promise((r) => setTimeout(r, SETTLE_MS));
  }
  return false;
}

/** The gas a claim needs: its `fee`, and the `floor` below which the payer
 *  gets a top-up, one fee unless the caller asks for more. */
export interface ClaimGas {
  fee: bigint;
  floor?: bigint;
}

/** Make sure `payer` can pay a claim's fee in PGAS before it signs. Returns
 *  null when it can, already or after a top-up, or why it cannot. */
export async function ensureClaimGas(
  api: AssetHubApi,
  payer: string,
  gas: ClaimGas,
  onStatus: OnSubmitStatus,
): Promise<WriteFailure | null> {
  const { fee, floor = fee } = gas;
  if (fee <= 0n) return null;
  const assetId = await api.constants.Pgas.PgasAssetId();
  const held = await pgasOf(api, assetId, payer);
  if (held >= floor) return null;

  const from = await ownAccountAddress();
  if (!from) return noGas('no host product account to take gas from');

  // When product account 0 signs the claim itself, it pays from the allowance just claimed.
  if (sameAccount(from, payer)) {
    const failed = await requestDailyGas();
    if (failed) return failed;
    return (await settled(api, assetId, payer, fee)) ? null : noGas('the gas allowance did not reach the account');
  }

  const want = fee * CLAIMS_PER_TOP_UP - held;
  const draft = api.tx.Assets.transfer_keep_alive({
    id: assetId,
    target: MultiAddress.Id(payer),
    amount: want,
  });
  const transferFee = await draft.getEstimatedFees(getFakeTxCreator(from)).catch(() => fee);
  // Keep back this transfer's fee, with room to stay above PGAS's minimum balance.
  const reserve = transferFee * 3n;
  let available = await pgasOf(api, assetId, from);
  // Ask the host only when short: each ask spends one of the person's daily slots.
  if (available - reserve < want) {
    const failed = await requestDailyGas();
    if (failed) return failed;
    available = await pgasOf(api, assetId, from);
  }
  const room = available - reserve;
  const amount = room < want ? room : want;
  // With nothing to spare, the claim still goes ahead when the payer holds its fee.
  if (amount <= 0n || held + amount < fee) {
    return held >= fee ? null : noGas(`product account 0 holds ${available} PGAS, the claim needs ${fee}`);
  }

  const signer = await hostProductSigner(GAS_ACCOUNT_INDEX);
  if (!signer) return noGas('the host cannot sign for its product account');
  const transfer = api.tx.Assets.transfer_keep_alive({
    id: assetId,
    target: MultiAddress.Id(payer),
    amount,
  });
  const moved = await watchSubmission(transfer, signer, onStatus);
  if (!moved.ok) return moved.failure ?? noGas(moved.error ?? 'the gas transfer failed');
  return (await settled(api, assetId, payer, fee)) ? null : noGas('the moved gas did not show in time');
}

/** Jollity's account is topped up when it holds less than this many claims' gas. */
export const READY_FLOOR_CLAIMS = 3n;

let topUpRunning: Promise<void> | null = null;

/** Tops Jollity's account up ahead of a mint when it holds under
 *  READY_FLOOR_CLAIMS claims' gas. Calls during a top-up share it. Never throws. */
export function keepGasReady(api: AssetHubApi, payer: string, estimateFee: () => Promise<bigint>): Promise<void> {
  topUpRunning ??= topUpWhenLow(api, payer, estimateFee).finally(() => {
    topUpRunning = null;
  });
  return topUpRunning;
}

/** A top-up nobody asked for by hand writes a line to the log when it lands. */
const logTopUp: OnSubmitStatus = (status, facts) => {
  if (status === 'inBlock') console.log('[gas] topped up ahead of a mint', facts?.tx ?? '');
};

async function topUpWhenLow(api: AssetHubApi, payer: string, estimateFee: () => Promise<bigint>): Promise<void> {
  try {
    const fee = await estimateFee();
    const failure = await ensureClaimGas(api, payer, { fee, floor: fee * READY_FLOOR_CLAIMS }, logTopUp);
    if (failure) console.warn('[gas] no top-up ahead of a mint:', failure.detail);
  } catch (err) {
    console.warn('[gas] no top-up ahead of a mint:', err);
  }
}

/** Waits until no top-up is running. A mint waits for it before it submits. */
export function waitForGasTopUp(): Promise<void> {
  return topUpRunning ?? Promise.resolve();
}
