// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

/** Rejects if `promise` has not settled within `ms`. For awaits that must
 *  never hang forever (wedged sockets, an unresponsive host). */
export function withDeadline<T>(promise: Promise<T>, ms: number, what = 'operation'): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = globalThis.setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms);
    promise.then(
      (v) => {
        globalThis.clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        globalThis.clearTimeout(t);
        reject(e);
      },
    );
  });
}
