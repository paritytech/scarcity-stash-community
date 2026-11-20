// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// The one place an IndexedDB transaction's ending is read. A transaction
// finishes through three different events, and the error that doomed it lives
// on the failed request first: when `onerror` fires, `transaction.error` is
// still null, and only the later `onabort` carries it, so reading the
// transaction in `onerror` misclassifies every failure (a quota error
// included).

/** Settles when `tx` is done: null on commit, else the failure. Never rejects:
 *  storage trouble is a result here. */
export function txDone(tx: IDBTransaction): Promise<DOMException | null> {
  return new Promise((resolve) => {
    const failed = (event: Event) =>
      resolve(
        (event.target as IDBRequest | IDBTransaction | null)?.error ??
          tx.error ??
          new DOMException('aborted', 'AbortError'),
      );
    tx.oncomplete = () => resolve(null);
    tx.onabort = failed;
    tx.onerror = failed;
  });
}
