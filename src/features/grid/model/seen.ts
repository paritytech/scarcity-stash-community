// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// Which of a piece's copies and credits are New and not yet seen: what the
// New dot counts, and what an orb flies in for (engine/seen.ts).

import { isNewAt, type PieceState } from './field';

/** The hashes on `p` that are New at `now`, Unix seconds, and not in `seen`. */
export function unseenNew(p: PieceState, seen: ReadonlySet<string>, now: number): string[] {
  const out: string[] = [];
  for (const e of p.entries) if (!seen.has(e.hash) && isNewAt(e, now)) out.push(e.hash);
  for (const e of p.credits) if (!seen.has(e.hash) && isNewAt(e, now)) out.push(e.hash);
  return out;
}

/** The pieces holding something New and unseen, by index. */
export function unseenPieces(pieces: readonly PieceState[], seen: ReadonlySet<string>, now: number): Set<number> {
  const out = new Set<number>();
  pieces.forEach((p, i) => {
    if (unseenNew(p, seen, now).length > 0) out.add(i);
  });
  return out;
}
