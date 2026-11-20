// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// Notifies a source that its part of the chain changed, from the block stream its
// client already follows: a node allows four follows a connection, and every
// product shares one. Each block makes one batched read of what the source
// watches, and a different value means "read again". At most one check per
// `minIntervalMs`, always at the newest block.

export interface BlockRef {
  hash: string;
  number: number;
}

export interface BlockStream {
  subscribe(observer: { next: (block: BlockRef) => void; error?: (error: unknown) => void }): {
    unsubscribe(): void;
  };
}

export interface BlockWatchOptions {
  blocks: BlockStream;
  /** A signature of the watched values at `hash`; null while nothing is watched. */
  check: (hash: string) => Promise<string | null>;
  onChange: () => void;
  minIntervalMs: number;
}

export interface BlockWatch {
  /** Compares the next values with `signature`, the watched values as the
   *  source's own read found them; without one the next value is a change. */
  rebase(signature?: string): void;
  stop(): void;
}

export function watchBlocks(opts: BlockWatchOptions): BlockWatch {
  let latest: BlockRef | null = null;
  let checking = false;
  let lastCheckAt = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  // The value the next one is compared with; null when there is none.
  let last: string | null = null;
  // Bumped by rebase(), so a check that started before it is dropped.
  let epoch = 0;
  let stopped = false;

  function pump(): void {
    if (stopped || checking || latest === null || timer !== undefined) return;
    const wait = lastCheckAt + opts.minIntervalMs - Date.now();
    if (wait > 0) {
      timer = globalThis.setTimeout(() => {
        timer = undefined;
        pump();
      }, wait);
      return;
    }
    const block = latest;
    latest = null;
    checking = true;
    lastCheckAt = Date.now();
    const started = epoch;
    opts
      .check(block.hash)
      .then((signature) => {
        if (stopped || started !== epoch || signature === null) return;
        const changed = signature !== last;
        last = signature;
        if (changed) opts.onChange();
      })
      .catch(() => {
        // A block that went away or a busy node: the next block checks again,
        // and the source's backup poll covers a watch that keeps failing.
      })
      .finally(() => {
        checking = false;
        pump();
      });
  }

  const subscription = opts.blocks.subscribe({
    next: (block) => {
      latest = block;
      pump();
    },
    error: () => {
      // The stream ends when its client is replaced; the source watches the new one.
    },
  });

  return {
    rebase: (signature) => {
      epoch++;
      last = signature ?? null;
    },
    stop: () => {
      stopped = true;
      if (timer !== undefined) globalThis.clearTimeout(timer);
      subscription.unsubscribe();
    },
  };
}
