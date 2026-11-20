// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  saved: new Map<string, string>(),
  /** What a read of the host does instead of returning the saved value. */
  read: 'returns',
}));
vi.mock('@parity/product-sdk-host', () => ({
  getHostLocalStorage: async () => ({
    readString: (key: string) => {
      if (h.read === 'never returns') return new Promise<string>(() => {});
      if (h.read === 'fails') return Promise.reject(new Error('storage closed'));
      return Promise.resolve(h.saved.get(key) ?? '');
    },
    writeString: async (key: string, value: string) => {
      h.saved.set(key, value);
    },
    clear: async (key: string) => {
      h.saved.delete(key);
    },
  }),
}));

/** The storage of a page opened inside a host, or outside one. */
async function storageOf(isInContainer: boolean) {
  vi.resetModules();
  vi.doMock('@/shared/host/embed', () => ({ isInContainer }));
  return (await import('./stateStorage')).stateStorage;
}

afterEach(() => {
  h.saved.clear();
  h.read = 'returns';
  vi.doUnmock('@/shared/host/embed');
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('where the state is saved', () => {
  it('is host storage inside a host: an absent key reads as nothing, a saved value reads back', async () => {
    const storage = await storageOf(true);
    expect(await storage.getItem('pkt_collectibles_v1')).toBeNull();
    await storage.setItem('pkt_collectibles_v1', '{"state":{}}');
    expect(await storage.getItem('pkt_collectibles_v1')).toBe('{"state":{}}');
    await storage.removeItem('pkt_collectibles_v1');
    expect(h.saved.size).toBe(0);
  });

  it('is nowhere outside a host', async () => {
    const storage = await storageOf(false);
    await storage.setItem('pkt_collectibles_v1', '{"state":{}}');
    expect(await storage.getItem('pkt_collectibles_v1')).toBeNull();
    expect(h.saved.size).toBe(0);
  });
});

describe('a read the host does not return', () => {
  it('is given up after 3 seconds, as nothing saved, with the key logged', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const storage = await storageOf(true);
    h.saved.set('pkt_device_v1', '{"state":{}}');
    h.read = 'never returns';
    let read: string | null | undefined;
    void Promise.resolve(storage.getItem('pkt_device_v1')).then((value) => {
      read = value;
    });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(read).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toBeNull();
    expect(warn).toHaveBeenCalledWith('[storage] pkt_device_v1 was not read:', 'host storage timed out after 3s');
  });

  it('reads as nothing saved when the host fails it, with the key logged', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const storage = await storageOf(true);
    h.read = 'fails';
    expect(await storage.getItem('pkt_device_v1')).toBeNull();
    expect(warn).toHaveBeenCalledWith('[storage] pkt_device_v1 was not read:', 'storage closed');
  });
});
