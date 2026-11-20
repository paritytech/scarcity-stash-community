// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// What this device saves besides the holdings and the collections, in host
// storage under one key, read back before the first frame (app/main.tsx).

import { createJSONStorage, persist } from 'zustand/middleware';
import { createStore } from 'zustand/vanilla';

import { normalizeHash } from './hash';
import { stateStorage } from './stateStorage';

export interface DeviceState {
  /** The hashes of the NFTs and credits seen on this device, normalized, the
   *  oldest first. Null on a device that has seen none: a first open, or a new phone. */
  seen: readonly string[] | null;
  /** The step the grid last rested on. */
  gridStep: number | null;
  /** Whether the player has turned a piece by hand: "Drag to turn" retires. */
  turned: boolean;
  /** This install's id for telemetry: random, '' until it is made. */
  deviceId: string;
}

const KEY = 'pkt_device_v1';
const VERSION = 1;
const MAX_SEEN = 500;
const EMPTY: DeviceState = { seen: null, gridStep: null, turned: false, deviceId: '' };

export const deviceStore = createStore<DeviceState>()(
  persist(() => EMPTY, {
    name: KEY,
    version: VERSION,
    storage: createJSONStorage(() => stateStorage),
    skipHydration: true,
    // A saved state of another shape is dropped.
    migrate: () => EMPTY,
    merge: (saved, current) => ({ ...current, ...usableSaved(saved) }),
  }),
);

/** The saved state as far as it is well formed. */
function usableSaved(saved: unknown): DeviceState {
  if (!saved || typeof saved !== 'object') return EMPTY;
  const { seen, gridStep, turned, deviceId } = saved as Partial<Record<keyof DeviceState, unknown>>;
  return {
    seen: Array.isArray(seen) ? seen.filter((h): h is string => typeof h === 'string') : null,
    gridStep: typeof gridStep === 'number' ? gridStep : null,
    turned: turned === true,
    deviceId: typeof deviceId === 'string' && /^[0-9a-f]{16}$/.test(deviceId) ? deviceId : '',
  };
}

/** The hashes seen on this device. Something is seen once it was in view at a
 *  readable size for a moment, opened on its page, or landed with an orb
 *  (grid/engine/seen.ts). */
export function readSeen(): Set<string> {
  return new Set(deviceStore.getState().seen);
}

/** Add `hashes` to the seen ones, newest last, keeping the newest MAX_SEEN. */
export function recordSeen(hashes: readonly string[]): void {
  const all = [...(deviceStore.getState().seen ?? [])];
  const have = new Set(all);
  let added = false;
  for (const h of hashes) {
    const n = normalizeHash(h);
    if (have.has(n)) continue;
    have.add(n);
    all.push(n);
    added = true;
  }
  if (added) deviceStore.setState({ seen: all.slice(Math.max(0, all.length - MAX_SEEN)) });
}

/** Whether this device has seen anything before. */
export function openedBefore(): boolean {
  return deviceStore.getState().seen !== null;
}
