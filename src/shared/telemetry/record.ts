// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// One record per step of a journey: what the app did, when, and the facts of
// that step. Every sink sees the same records, formats them its own way, and
// never reaches back into a flow. The facts are public: ids the chain shows,
// the app's own account, the kind and reason of a failure. Never a key and
// never another person's name.

import type { FailureKind } from '@/shared/chain/failure';

/** The flows the app measures. */
export type Journey = 'open' | 'read' | 'mint';

/** How a step ended: 'ok' as it is reached; a failure, an overdue successor or
 *  the page going hidden are records of their own. */
export type Outcome = 'ok' | 'failed' | 'stalled' | 'hidden';

/** What a step may carry: numbers, ids, chain names (an error path, a block
 *  hash) and a failure's reason and detail as text. */
export interface Facts {
  /** The transaction hash of a write, 0x prefixed. */
  tx?: string;
  /** The block the write landed in, by number and hash. */
  block?: number;
  blockHash?: string;
  collection?: number;
  item?: number;
  /** An NFT instance, in decimal. */
  instance?: string;
  /** A credit's hash, 0x prefixed. */
  credit?: string;
  /** The account a mint landed in. */
  purse?: string;
  /** How many of something: pieces picked, files, attempts. */
  count?: number;
  /** The screen a link opened the app on. */
  target?: string;
  /** A classified failure and its chain reason. */
  kind?: FailureKind;
  reason?: string;
  /** The raw detail, for the log and the event, never for a tag. */
  detail?: string;
  /** Milliseconds, where a step reports a duration of its own. */
  ms?: number;
}

export interface StepRecord {
  /** Wall clock at the call, ms since the epoch. */
  at: number;
  /** This app open, this journey. */
  session: string;
  request: string;
  journey: Journey;
  step: string;
  outcome: Outcome;
  /** Since the journey started, and since its previous record, in ms. */
  sinceStart: number;
  sincePrev: number;
  facts: Facts;
}

/** Where records go. A sink never throws into a flow: log.ts catches what it throws. */
export interface Sink {
  record(r: StepRecord): void;
}
