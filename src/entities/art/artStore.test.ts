// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ArtStore from './artStore';
import type { KeptCell } from './artStore';

// Each test opens its own store: a fresh module, so no connection or state
// carries over from the test before.
let store: typeof ArtStore;
const openStore = async (): Promise<void> => {
  vi.resetModules();
  store = await import('./artStore');
};

const MB = 1024 * 1024;

// fake-indexeddb schedules its callbacks with setImmediate, so these tests
// must not fake macrotask timers (faking only Date, as below, is fine).
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('artStore', () => {
  beforeEach(async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    await openStore();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('round-trips bytes and type by cid', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    await store.putArt('cid-a', bytes, 'image/webp');
    const got = await store.getArt('cid-a');
    expect(got?.type).toBe('image/webp');
    expect(Array.from(got!.bytes)).toEqual([1, 2, 3, 4, 5]);
  });

  it('returns null for a cid it has never kept', async () => {
    expect(await store.getArt('cid-unknown')).toBeNull();
  });

  it('forgets a removed row', async () => {
    await store.putArt('cid-a', new Uint8Array([1]), 'image/png');
    await store.removeArt('cid-a');
    expect(await store.getArt('cid-a')).toBeNull();
  });

  it('keeps everything under 200 MB: past it, the least recently shown go first, and a read refreshes its row', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000);
    await store.putArt('cid-old', new Uint8Array(70 * MB), 'image/webp');
    vi.setSystemTime(2_000);
    await store.putArt('cid-mid', new Uint8Array(70 * MB), 'image/webp');
    vi.setSystemTime(3_000);
    await store.putArt('cid-new', new Uint8Array(50 * MB), 'image/webp');
    // Showing the oldest picture again moves it to the back of the queue...
    vi.setSystemTime(4_000);
    expect(await store.getArt('cid-old')).not.toBeNull();
    await settle(); // the age refresh is fire-and-forget
    // ...so the 10 MB this picture needs past 200 MB come out of cid-mid.
    vi.setSystemTime(5_000);
    await store.putArt('cid-last', new Uint8Array(20 * MB), 'image/webp');
    expect(await store.getArt('cid-old')).not.toBeNull();
    expect(await store.getArt('cid-mid')).toBeNull();
    expect(await store.getArt('cid-new')).not.toBeNull();
    expect(await store.getArt('cid-last')).not.toBeNull();
  });

  it('frees bytes, not a row count: one big stale row can be room enough', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000);
    await store.putArt('cid-big', new Uint8Array(150 * MB), 'image/webp');
    vi.setSystemTime(2_000);
    await store.putArt('cid-small', new Uint8Array([1]), 'image/webp');
    vi.setSystemTime(3_000);
    await store.putArt('cid-new', new Uint8Array(60 * MB), 'image/webp');
    expect(await store.getArt('cid-big')).toBeNull();
    expect(await store.getArt('cid-small')).not.toBeNull();
    expect(await store.getArt('cid-new')).not.toBeNull();
  });

  it('counts a picture written again once, and never keeps one larger than 200 MB', async () => {
    await store.putArt('cid-a', new Uint8Array(120 * MB), 'image/webp');
    await store.putArt('cid-b', new Uint8Array(60 * MB), 'image/webp');
    await store.putArt('cid-a', new Uint8Array(120 * MB), 'image/webp'); // replaces its own bytes, needs no room
    expect(await store.getArt('cid-b')).not.toBeNull();
    await store.putArt('cid-huge', new Uint8Array(200 * MB + 1), 'image/webp');
    expect(await store.getArt('cid-huge')).toBeNull();
    expect(await store.getArt('cid-a')).not.toBeNull();
    expect(await store.getArt('cid-b')).not.toBeNull();
  });

  it('a quota error evicts just enough least-recently-shown bytes, then retries once', async () => {
    // A scripted IndexedDB, because fake-indexeddb enforces no quota: the first
    // put fails the way it fails in real engines (the request's error
    // reaches tx.onerror while tx.error is still null, and only the abort
    // carries it), then the eviction cursor walks `meta` oldest first and the
    // retried put lands.
    const metaRows = [
      { cid: 'small-old', at: 1, size: 2 },
      { cid: 'big-mid', at: 2, size: 8 },
      { cid: 'small-new', at: 3, size: 2 },
    ];
    const evicted: string[] = [];
    const artPuts: string[] = [];
    let refusals = 1;
    // The handful of IndexedDB surface the store touches, as the store sees it.
    interface Events {
      onsuccess?: () => void;
      onerror?: (ev: unknown) => void;
      onabort?: (ev: unknown) => void;
      oncomplete?: () => void;
    }
    const makeTx = () => {
      let failure: Error | null = null;
      let scheduled = false;
      const tx: Events & { error: Error | null; objectStore?: (name: string) => unknown } = { error: null };
      const finish = () => {
        if (scheduled) return;
        scheduled = true;
        setTimeout(() => {
          if (failure) {
            tx.onerror?.({ target: { error: failure } }); // tx.error not yet set
            tx.error = failure;
            tx.onabort?.({ target: tx });
          } else tx.oncomplete?.();
        }, 0);
      };
      tx.objectStore = (name: string) => ({
        getAll: () => {
          const req: Events & { result?: unknown } = {};
          setTimeout(() => {
            req.result = name === 'meta' ? metaRows : [];
            req.onsuccess?.();
          }, 0);
          return req;
        },
        put: (row: { cid: string }) => {
          if (name === 'art') {
            if (refusals > 0) {
              refusals--;
              failure = Object.assign(new Error('full'), { name: 'QuotaExceededError' });
            } else artPuts.push(row.cid);
          }
          finish();
          return {};
        },
        delete: (cid: string) => {
          if (name === 'art') evicted.push(cid);
        },
        index: () => ({
          openCursor: () => {
            const walker: Events & { result?: unknown } = {};
            const step = (i: number) =>
              setTimeout(() => {
                const row = metaRows[i];
                const cursor = { advanced: false };
                walker.result = row
                  ? {
                      value: row,
                      delete: () => {},
                      continue: () => {
                        cursor.advanced = true;
                        step(i + 1);
                      },
                    }
                  : null;
                walker.onsuccess?.();
                if (!cursor.advanced) finish();
              }, 0);
            step(0);
            return walker;
          },
        }),
      });
      return tx;
    };
    vi.stubGlobal('indexedDB', {
      open: () => {
        const req: Events & { result?: unknown } = {};
        setTimeout(() => {
          req.result = { transaction: () => makeTx(), close: () => {} };
          req.onsuccess?.();
        }, 0);
        return req;
      },
    });
    await openStore();
    await store.putArt('fresh', new Uint8Array(6), 'image/webp');
    // 6 bytes wanted: the 2-byte then the 8-byte row go, the newest survives.
    expect(evicted).toEqual(['small-old', 'big-mid']);
    expect(artPuts).toEqual(['fresh']);
  });

  it('gives up on an open that never settles, so a silent IndexedDB cannot hold every picture', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('indexedDB', { open: () => ({}) }); // a request that fires no event at all
    await openStore();
    const pending = store.getArt('cid-a');
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(pending).resolves.toBeNull();
  });

  it('degrades silently where IndexedDB is missing', async () => {
    vi.stubGlobal('indexedDB', undefined);
    await openStore();
    await expect(store.putArt('cid-a', new Uint8Array([1]), 'image/webp')).resolves.toBeUndefined();
    await expect(store.getArt('cid-a')).resolves.toBeNull();
    await expect(store.removeArt('cid-a')).resolves.toBeUndefined();
  });

  it('degrades silently where opening IndexedDB throws', async () => {
    vi.stubGlobal('indexedDB', {
      open: () => {
        throw new Error('refused');
      },
    });
    await openStore();
    await expect(store.putArt('cid-a', new Uint8Array([1]), 'image/webp')).resolves.toBeUndefined();
    await expect(store.getArt('cid-a')).resolves.toBeNull();
  });
});

describe('the small grid copies', () => {
  beforeEach(async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    await openStore();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const cell = (url: string, fill = 1): KeptCell => ({
    url,
    rgba: new Uint8Array(16).fill(fill),
    color: 'rgb(1,2,3)',
    gap: 0.1,
  });

  it('come back with their pixels, oldest first, a copy kept again replacing its older one', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000);
    await store.keepCells([cell('a'), cell('b')]);
    vi.setSystemTime(2_000);
    await store.keepCells([cell('a', 9)]);
    const back = await store.readCells();
    expect(back.map((c) => c.url)).toEqual(['b', 'a']);
    expect(Array.from(back[1]!.rgba)).toEqual(new Array<number>(16).fill(9));
    expect(back[1]).toMatchObject({ color: 'rgb(1,2,3)', gap: 0.1 });
  });

  it('keep at most 400, the oldest going first', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_000);
    await store.keepCells(Array.from({ length: 399 }, (_, i) => cell(`old-${String(i).padStart(3, '0')}`)));
    vi.setSystemTime(2_000);
    await store.keepCells([cell('new-0'), cell('new-1'), cell('new-2')]);
    const back = await store.readCells();
    expect(back).toHaveLength(400);
    expect(back.slice(0, 2).map((c) => c.url)).toEqual(['old-002', 'old-003']);
    expect(back.slice(-3).map((c) => c.url)).toEqual(['new-0', 'new-1', 'new-2']);
  });

  it('open a store an earlier version kept, its pictures still there', async () => {
    const factory = new IDBFactory();
    vi.stubGlobal('indexedDB', factory);
    await new Promise<void>((resolve) => {
      const req = factory.open('pkt_art', 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('art', { keyPath: 'cid' });
        req.result.createObjectStore('meta', { keyPath: 'cid' }).createIndex('at', 'at');
      };
      req.onsuccess = () => {
        const tx = req.result.transaction(['art', 'meta'], 'readwrite');
        tx.objectStore('art').put({ cid: 'cid-a', bytes: new Uint8Array([7]), type: 'image/png' });
        tx.objectStore('meta').put({ cid: 'cid-a', at: 1, size: 1 });
        tx.oncomplete = () => {
          req.result.close();
          resolve();
        };
      };
    });
    await openStore();
    expect(Array.from((await store.getArt('cid-a'))!.bytes)).toEqual([7]);
    await store.keepCells([cell('a')]);
    expect((await store.readCells()).map((c) => c.url)).toEqual(['a']);
  });

  it('degrade to none where IndexedDB is missing', async () => {
    vi.stubGlobal('indexedDB', undefined);
    await openStore();
    await expect(store.keepCells([cell('a')])).resolves.toBeUndefined();
    await expect(store.readCells()).resolves.toEqual([]);
  });
});
