// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// Where the app saves its state: this app's host storage, one value per key.
// Host storage is asynchronous, so app/main.tsx reads every saved value before
// it draws the first frame.

import { getHostLocalStorage } from '@parity/product-sdk-host';
import type { StateStorage } from 'zustand/middleware';

import { isInContainer } from '@/shared/host/embed';

import { withDeadline } from './deadline';

/** A read that has not returned by then is given up and its late value is
 *  dropped: the app opens as on a first open instead of waiting. */
const READ_DEADLINE_MS = 3_000;

/** This app's host storage, per device. A read that fails or is given up
 *  returns nothing and logs the key; a write that fails clears the key, so an
 *  older value never opens a later launch. */
const hostStorage: StateStorage = {
  getItem: async (name) => {
    try {
      const read = getHostLocalStorage().then((storage) => storage?.readString(name));
      return (await withDeadline(read, READ_DEADLINE_MS, 'host storage')) || null;
    } catch (err) {
      console.warn(`[storage] ${name} was not read:`, err instanceof Error ? err.message : String(err));
      return null;
    }
  },
  setItem: async (name, value) => {
    const storage = await getHostLocalStorage().catch(() => null);
    try {
      await storage?.writeString(name, value);
    } catch {
      await storage?.clear(name).catch(() => {});
    }
  },
  removeItem: async (name) => {
    await (await getHostLocalStorage().catch(() => null))?.clear(name).catch(() => {});
  },
};

/** Keeps nothing. */
const noStorage: StateStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

/** Host storage inside a host. Outside one nothing is saved. */
export const stateStorage: StateStorage = isInContainer ? hostStorage : noStorage;
