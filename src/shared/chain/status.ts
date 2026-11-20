// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// Whether the chain sync is healthy, so the UI can distinguish an empty grid from one
// that cannot reach the chains. It follows the NFT read: `idle` outside a host,
// `ok` once it landed, `waiting` while it waits on the Polkadot app, `error`
// while it fails and retries.

import { createObservable } from '@/shared/lib/observable';

export type ChainSyncStatus = 'idle' | 'ok' | 'waiting' | 'error';

/** Why the last NFT read failed, carried alongside the
 *  'error' status so the empty-state screen can show more than "reconnecting". */
export interface ChainSyncError {
  /** A one-line, human-readable category (holdings/sync.ts classifies it). */
  message: string;
}

const status = createObservable<ChainSyncStatus>('idle');
const error = createObservable<ChainSyncError | null>(null);
const refreshFailing = createObservable<boolean>(false);

/** Sets the sync status, with the reason on 'error'. The reason is set first,
 *  so a status subscriber reads it settled. */
export function setChainSyncStatus(next: ChainSyncStatus, reason: ChainSyncError | null = null): void {
  error.set(next === 'error' ? reason : null);
  status.set(next);
}

/** Calls cb immediately with the current status, then on every change.
 *  Returns an unsubscribe function. */
export function subscribeChainSyncStatus(cb: (status: ChainSyncStatus) => void): () => void {
  return status.subscribe(cb);
}

/** The reason behind the current 'error' status (null when not in error).
 *  Same immediate-then-on-change contract as subscribeChainSyncStatus. */
export function subscribeChainSyncError(cb: (error: ChainSyncError | null) => void): () => void {
  return error.subscribe(cb);
}

/** Whether the last read of the NFTs or the credits failed: the grid stays as
 *  it was and shows a quiet note, until a read lands again. */
export function setRefreshFailing(failing: boolean): void {
  if (refreshFailing.get() !== failing) refreshFailing.set(failing);
}

/** Same immediate-then-on-change contract as subscribeChainSyncStatus. */
export function subscribeRefreshFailing(cb: (failing: boolean) => void): () => void {
  return refreshFailing.subscribe(cb);
}
