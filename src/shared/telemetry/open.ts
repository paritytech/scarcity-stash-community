// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// The app open: from the first script to the grid drawn with live reads. One
// journey per app open, closed once the grid is drawn and both live reads,
// the NFTs and the credits, have landed.

import { journey } from './log';
import type { Facts } from './record';

export type OpenStep =
  'saved read' | 'ready' | 'saved shown' | 'grid drawn' | 'NFTs read' | 'credits read' | 'opened to';

const opening = journey('open');
const reached = new Set<OpenStep>();
/** The next step may take this long before the open counts as stalled. */
const OPEN_BUDGET_MS = 60_000;

/** A step of the open reached, recorded once; the open is done at the last of
 *  the three that end it. */
export function openStep(step: OpenStep, facts?: Facts): void {
  if (reached.has(step)) return;
  reached.add(step);
  opening.step(step, facts, OPEN_BUDGET_MS);
  if (reached.has('grid drawn') && reached.has('NFTs read') && reached.has('credits read')) opening.done();
}
