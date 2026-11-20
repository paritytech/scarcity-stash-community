// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// Whether a read failed only because the block it read at is gone: the chain
// library lets go of old blocks, and of all of them when its follow ends. The
// same read started again reads at the newest block and works, so it starts
// again at once rather than backing off.

/** The messages that report the block, or the follow it belonged to, as gone. */
const LOST =
  /is not pinned|ChainHead (?:disjointed|stopped)|"archive_v1_\w+" is not supported|unknown follow subscription id/;

/** The chain library's names for the same, when the error keeps its class. */
const LOST_NAMES = new Set(['BlockNotPinnedError', 'DisjointError', 'StopError']);

/** How soon such a read starts again: time for the library to follow anew. */
export const READ_AGAIN_MS = 500;

/** The error and the errors it was caused by, outermost first. */
function* causes(error: unknown): Generator {
  let current = error;
  for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth++) {
    yield current;
    current = typeof current === 'object' ? (current as { cause?: unknown }).cause : undefined;
  }
}

export function isLostBlock(error: unknown): boolean {
  for (const e of causes(error)) {
    if (typeof e === 'string') {
      if (LOST.test(e)) return true;
      continue;
    }

    const { name, message } = e as { name?: unknown; message?: unknown };
    if (typeof name === 'string' && LOST_NAMES.has(name)) return true;
    if (typeof message === 'string' && LOST.test(message)) return true;
  }
  return false;
}
