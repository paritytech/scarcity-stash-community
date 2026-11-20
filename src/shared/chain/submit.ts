// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// Signs, submits and watches one transaction for every write the app makes.
// It settles once the transaction is in a block, not at finality, and never
// rejects. The `signed` and `broadcast` statuses bracket papi's validation of
// the signed transaction, so the journeys measure that wait.

import { classifyDispatchError, classifyValidityError, type WriteFailure } from './failure';
import type { ChainSigner } from './signer';

/** Coarse progress of a submission, for an overlay's status line. */
export type SubmitStatus = 'signing' | 'signed' | 'broadcast' | 'inBlock' | 'finalized';

/** What the chain has reported about a submission so far: its hash once signed,
 *  its block once in one, so a record can name the transaction. */
interface SubmitFacts {
  tx?: string;
  block?: number;
  blockHash?: string;
}

/** A status callback; the facts are those known at the call. */
export type OnSubmitStatus = (status: SubmitStatus, facts?: SubmitFacts) => void;

/** One event of a landed transaction, as papi decodes it: the pallet, then
 *  the event and its fields. */
export interface ChainEvent {
  type: string;
  value: { type: string; value: unknown };
}

export interface SubmitResult extends SubmitFacts {
  ok: boolean;
  /** The events the transaction emitted, once it landed. */
  events?: ChainEvent[];
  /** Technical reason when `ok` is false: the diagnostic-log string, mirror of
   *  `failure.detail`. Kept for the flow-event `detail` path. */
  error?: string;
  /** Classified cause when `ok` is false: drives the retries in credits/claim.ts
   *  and the reconcile and stop rule in features/holdings/mint.ts. */
  failure?: WriteFailure;
}

/** A submission with no final event by now settles as transient, so a mint
 *  never hangs. */
const SUBMIT_TIMEOUT_MS = 75_000;

/** Build a failed result from a classified cause. */
export function failResult(failure: WriteFailure): SubmitResult {
  return { ok: false, error: failure.detail, failure };
}

/** The part of a papi transaction this module watches; `options` passes papi's
 *  tip, mortality or nonce. */
interface WatchableTx {
  createSubmitAndWatch(
    signer: ChainSigner,
    options?: unknown,
  ): {
    subscribe(observer: { next: (event: TxWatchEvent) => void; error: (err: unknown) => void }): {
      unsubscribe: () => void;
    };
  };
}

// The part of papi's TxEvent stream this module reads, flat so `type` compares
// against several tags. A transaction dropped after broadcast errors the stream.
interface TxWatchEvent {
  type: string;
  txHash?: string;
  block?: { hash: string; number: number };
  events?: ChainEvent[];
  ok?: boolean;
  dispatchError?: { type: string; value: unknown };
}

/** Signs, submits and watches `tx` until it is in a block, whose event carries
 *  the outcome. Never rejects; past SUBMIT_TIMEOUT_MS it settles as transient. */
export function watchSubmission(
  tx: WatchableTx,
  signer: ChainSigner,
  onStatus: OnSubmitStatus,
  options?: unknown,
): Promise<SubmitResult> {
  return new Promise<SubmitResult>((resolve) => {
    const facts: SubmitFacts = {};
    onStatus('signing', facts);
    // `sub` is null until subscribe() returns, and the stream can settle before that.
    const watch: { settled: boolean; sub: { unsubscribe: () => void } | null } = { settled: false, sub: null };
    const done = (result: SubmitResult): void => {
      if (watch.settled) return;
      watch.settled = true;
      clearTimeout(timer);
      watch.sub?.unsubscribe();
      resolve(result);
    };
    // Set before subscribing: the stream can end inside subscribe() itself.
    const timer = setTimeout(
      () =>
        done({
          ...failResult({
            kind: 'transient',
            detail: `no response within ${SUBMIT_TIMEOUT_MS / 1000}s`,
          }),
          ...facts,
        }),
      SUBMIT_TIMEOUT_MS,
    );
    const dispatched = (event: TxWatchEvent): SubmitResult =>
      event.ok
        ? { ok: true, ...facts, ...(event.events ? { events: event.events } : {}) }
        : { ...failResult(classifyDispatchError(event.dispatchError)), ...facts };

    watch.sub = tx.createSubmitAndWatch(signer, options).subscribe({
      next: (event) => {
        // Every event carries the transaction hash; events from a block also carry the block.
        if (event.txHash) facts.tx = event.txHash;
        if (event.block) {
          facts.block = event.block.number;
          facts.blockHash = event.block.hash;
        }
        if (event.type === 'created') {
          onStatus('signed', facts);
        } else if (event.type === 'broadcasted') {
          onStatus('broadcast', facts);
        } else if (event.type === 'inBestBlock') {
          onStatus('inBlock', facts);
          done(dispatched(event));
        } else if (event.type === 'finalized') {
          done(dispatched(event));
        }
      },
      error: (err: unknown) => {
        done({ ...failResult(classifyValidityError(err instanceof Error ? err.message : String(err))), ...facts });
      },
    });
    // A stream that settled inside subscribe() is closed now that its handle exists.
    if (watch.settled) watch.sub.unsubscribe();
  });
}
