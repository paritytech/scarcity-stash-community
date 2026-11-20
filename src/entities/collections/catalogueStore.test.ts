// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// When the grid may lay a collection out: as soon as a catalogue is in, the one
// saved in host storage included while a fresh read runs, so a kept field never
// waits for the network. A read that only lost its block starts again at once
// instead of showing the collection as failed, and one that failed stays failed
// through its retries.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({ loadCatalogue: vi.fn(), saved: new Map<string, string>() }));
vi.mock('@/shared/lib/stateStorage', () => ({
  stateStorage: {
    getItem: (k: string) => fake.saved.get(k) ?? null,
    setItem: (k: string, v: string) => void fake.saved.set(k, v),
    removeItem: (k: string) => void fake.saved.delete(k),
  },
}));
vi.mock('@/shared/chain/client', () => ({ getChainApis: async () => ({}) }));
vi.mock('./catalogue', () => ({ fetchCatalogue: (_apis: unknown, id: number) => fake.loadCatalogue(id) }));

import { READ_AGAIN_MS } from '@/shared/chain/lostBlock';

import {
  catalogueReady,
  currentCatalogues,
  ensureCatalogues,
  restoreCatalogues,
  subscribeCatalogues,
} from './catalogueStore';
import { RETRY_DELAYS_MS } from './registry';

const ITEM = { itemIndex: 0 } as never;

/** The statuses collection `id` goes through, each change once. Returns the list and the stop. */
function watchStatuses(id: string): { seen: string[]; off: () => void } {
  const seen: string[] = [];
  const off = subscribeCatalogues((slots) => {
    const status = slots[id]?.status;
    if (status && status !== seen.at(-1)) seen.push(status);
  });
  return { seen, off };
}

describe('the saved catalogues', () => {
  const savedCatalogues = (): unknown => JSON.parse(fake.saved.get('pkt_catalogues_v1')!);

  it('are read back, the malformed ones dropped', async () => {
    fake.saved.set('pkt_catalogues_v1', JSON.stringify({ '40': [{ itemIndex: 0 }, 'x'], '41': 'not a list' }));
    await restoreCatalogues();
    expect(currentCatalogues()).toEqual({ '40': { items: [{ itemIndex: 0 }], status: 'ready' } });

    fake.saved.set('pkt_catalogues_v1', 'not JSON');
    await restoreCatalogues();
    expect(currentCatalogues()).toEqual({});
  });

  it('take a read that landed, with the metadata the grid and the detail read', async () => {
    fake.loadCatalogue.mockResolvedValueOnce([{ itemIndex: 3, metadata: { rarity: 'rare', colour: 'red' } }]);
    ensureCatalogues(['42']);
    await vi.waitFor(() => expect(currentCatalogues()['42']?.status).toBe('ready'));
    expect(savedCatalogues()).toEqual({ '42': [{ itemIndex: 3, metadata: { rarity: 'rare' } }] });
  });
});

describe('a catalogue the grid can lay out', () => {
  it('is the one kept on the device while a fresh read runs', () => {
    expect(catalogueReady({ items: [ITEM], status: 'loading' })).toBe(true);
  });

  it('is not one still loading with nothing kept, nor one never asked for', () => {
    expect(catalogueReady({ items: null, status: 'loading' })).toBe(false);
    expect(catalogueReady(undefined)).toBe(false);
  });

  it('is one whose read gave up or was skipped, so the field opens without it', () => {
    expect(catalogueReady({ items: null, status: 'failed' })).toBe(true);
    expect(catalogueReady({ items: null, status: 'skipped' })).toBe(true);
  });
});

describe('a catalogue read that did not land', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', globalThis);
    fake.loadCatalogue.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('starts again at once after a lost block and never shows the collection as failed', async () => {
    const lost = Object.assign(new Error('Block 0xab is not pinned (stop-storage)'), { name: 'BlockNotPinnedError' });
    fake.loadCatalogue.mockRejectedValueOnce(lost).mockResolvedValueOnce([ITEM]);
    const { seen, off } = watchStatuses('31');

    ensureCatalogues(['31']);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(READ_AGAIN_MS);

    expect(currentCatalogues()['31']).toEqual({ items: [ITEM], status: 'ready' });
    expect(seen).not.toContain('failed');
    expect(fake.loadCatalogue).toHaveBeenCalledTimes(2);
    off();
  });

  it('stays failed while its retries run, until one lands', async () => {
    const down = new Error('no chain connection this session');
    fake.loadCatalogue.mockRejectedValueOnce(down).mockRejectedValueOnce(down).mockResolvedValueOnce([ITEM]);
    const { seen, off } = watchStatuses('32');

    ensureCatalogues(['32']);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0]!);
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[1]!);

    expect(seen).toEqual(['loading', 'failed', 'ready']);
    expect(fake.loadCatalogue).toHaveBeenCalledTimes(3);
    off();
  });
});
