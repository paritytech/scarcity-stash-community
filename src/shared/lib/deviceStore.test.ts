// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as DeviceStore from './deviceStore';

const h = vi.hoisted(() => ({ saved: new Map<string, string>() }));
vi.mock('./stateStorage', () => ({
  stateStorage: {
    getItem: (k: string) => h.saved.get(k) ?? null,
    setItem: (k: string, v: string) => void h.saved.set(k, v),
    removeItem: (k: string) => void h.saved.delete(k),
  },
}));

const KEY = 'pkt_device_v1';
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const ID = 'ab'.repeat(8);

let deviceStore: typeof DeviceStore.deviceStore;
let openedBefore: typeof DeviceStore.openedBefore;
let readSeen: typeof DeviceStore.readSeen;
let recordSeen: typeof DeviceStore.recordSeen;

// A fresh page per test: the store made anew over what is saved.
beforeEach(async () => {
  vi.resetModules();
  ({ deviceStore, openedBefore, readSeen, recordSeen } = await import('./deviceStore'));
});
afterEach(() => {
  h.saved.clear();
});

describe('what this device has seen', () => {
  it('starts empty and records what it is given, normalized', () => {
    expect(readSeen().size).toBe(0);
    recordSeen([`0x${A.toUpperCase()}`, B]);
    expect([...readSeen()]).toEqual([A, B]);
    recordSeen([A]);
    expect(JSON.parse(h.saved.get(KEY)!)).toMatchObject({ state: { seen: [A, B] } });
  });

  it('keeps the newest five hundred', () => {
    recordSeen(Array.from({ length: 501 }, (_, k) => String(k).padStart(64, '0')));
    const kept = readSeen();
    expect(kept.size).toBe(500);
    expect(kept.has('0'.repeat(64))).toBe(false);
    expect(kept.has('500'.padStart(64, '0'))).toBe(true);
  });

  it('distinguishes a device that opened before from one that never did', () => {
    expect(openedBefore()).toBe(false);
    recordSeen([A]);
    expect(openedBefore()).toBe(true);
  });
});

describe('what the device saved', () => {
  const save = (state: unknown, version = 1): void => {
    h.saved.set(KEY, JSON.stringify({ state, version }));
  };

  it('is read back only by rehydrate', async () => {
    save({ seen: [A], gridStep: 2, turned: true, deviceId: ID });
    expect(deviceStore.getState().seen).toBeNull();
    await deviceStore.persist.rehydrate();
    expect(deviceStore.getState()).toEqual({ seen: [A], gridStep: 2, turned: true, deviceId: ID });
    expect(openedBefore()).toBe(true);
  });

  it('drops malformed values one by one, and a state saved in another version whole', async () => {
    save({ seen: [A, 7], gridStep: '2', turned: 1, deviceId: 'short' });
    await deviceStore.persist.rehydrate();
    expect(deviceStore.getState()).toEqual({ seen: [A], gridStep: null, turned: false, deviceId: '' });

    save({ seen: [A], gridStep: 2, turned: true, deviceId: ID }, 0);
    await deviceStore.persist.rehydrate();
    expect(deviceStore.getState()).toEqual({ seen: null, gridStep: null, turned: false, deviceId: '' });
  });
});
