// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// Which block the Stash reads at. What the grid shows is read at SHOW_AT, the
// newest block by default: finalized trails it by about 26 s, and the Stash's
// own transactions land on the newest, so a finalized grid would lag them.
// Reads that build a transaction always take NEWEST: older state can be void.

export type ReadBlock = 'best' | 'finalized';

/** The block every read of what the grid shows is taken at. */
export const SHOW_AT: ReadBlock = 'best';

/** SHOW_AT in the typed api's options shape. */
export const SHOW = { at: SHOW_AT } as const;

/** The newest block, for reads that build a transaction. */
export const NEWEST = { at: 'best' } as const;
