// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// Whether the device has a network at all, as the webview reports it:
// navigator.onLine and the online and offline events. Offline is a fact, the
// device has no network and nothing can land. Online only means a network is
// up, not that the chains can be reached, so a read that fails while online is still
// trying again.

import { createObservable } from './observable';

const online = createObservable(typeof navigator === 'undefined' || navigator.onLine);

if (typeof window !== 'undefined') {
  const follow = (): void => {
    const now = navigator.onLine;
    if (now !== online.get()) online.set(now);
  };
  window.addEventListener('online', follow);
  window.addEventListener('offline', follow);
}

/** Whether the device has a network now. */
export const onlineNow = (): boolean => online.get();

/** Calls cb with whether the device has a network now, then on every change. */
export const subscribeOnline = (cb: (online: boolean) => void): (() => void) => online.subscribe(cb);
