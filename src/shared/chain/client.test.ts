// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as Client from './client';

// Mutable seams shared with the mocked modules (hoisted above the imports).
const h = vi.hoisted(() => {
  /** Each fake client's finalized-block listener, by chain name, newest client last. */
  const finalized: Record<string, ((block: { hash: string; number: number }) => void)[]> = {};
  class ChainNotSupportedError extends Error {}
  class HostUnavailableError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'HostUnavailableError';
    }
  }
  return {
    ChainNotSupportedError,
    HostUnavailableError,
    ASSET_HUB_GENESIS: '0xa55e7',
    PEOPLE_GENESIS: '0xpe0p1e',
    state: { inContainer: true },
    /** Genesis hashes the fake host serves. */
    supported: new Set<string>(),
    createChainClient: vi.fn(),
    isChainSupported: vi.fn(),
    finalized,
    /** The client of each chain, from the first ask for it until it is destroyed. */
    clients: new Map<string, Promise<unknown>>(),
    /** Settles when the fake host gives a new client out. */
    hostAnswers: Promise.resolve(),
  };
});

vi.mock('@parity/product-sdk-chain-client', () => ({ createChainClient: h.createChainClient }));
vi.mock('@parity/product-sdk-host', () => ({
  isChainSupported: h.isChainSupported,
  ChainNotSupportedError: h.ChainNotSupportedError,
}));
vi.mock('@polkadot-api/descriptors', () => ({
  paseoAssetHub: { genesis: h.ASSET_HUB_GENESIS },
  paseoPeople: { genesis: h.PEOPLE_GENESIS },
  previewnetAssetHub: { genesis: '0xpreviewnet-asset-hub' },
  previewnetPeople: { genesis: '0xpreviewnet-people' },
}));
vi.mock('@/shared/host/embed', () => ({
  get isInContainer() {
    return h.state.inContainer;
  },
}));

let getChainApis: typeof Client.getChainApis;
let isChainLive: typeof Client.isChainLive;
let rebuildChain: typeof Client.rebuildChain;

const { ASSET_HUB_GENESIS, PEOPLE_GENESIS } = h;

// Mirrors the SDK: a rejected chain's client throws on property access. A fake
// that resolved plainly would go green against a probe that never checks.
function fakeClient(name: string, genesis: string) {
  const destroy = vi.fn();
  // `raw` mirrors the typed api: ChainApis carries both, because the
  // product-sdk reads pin a finalized block off the raw client, and the
  // finalized blocks it streams are how a chain counts as live.
  const finalizedBlock$ = {
    subscribe: (observer: { next: (block: { hash: string; number: number }) => void }) => {
      (h.finalized[name] ??= []).push(observer.next);
      return { unsubscribe: () => {} };
    },
  };
  if (h.supported.has(genesis)) {
    return { [name]: { query: {} }, raw: { [name]: { raw: true, finalizedBlock$ } }, destroy };
  }
  return {
    destroy,
    raw: { [name]: { raw: true } },
    get [name](): never {
      throw new h.ChainNotSupportedError(`${name} not served`);
    },
  };
}

// A fresh module per test, so every test opens its own connections.
beforeEach(async () => {
  vi.resetModules();
  ({ getChainApis, isChainLive, rebuildChain } = await import('./client'));
  h.state.inContainer = true;
  h.supported.clear();
  h.finalized = {};
  h.isChainSupported
    .mockReset()
    .mockImplementation(async (genesis: string) => ({ ok: true, value: h.supported.has(genesis) }));
  h.clients.clear();
  h.hostAnswers = Promise.resolve();
  // Mirrors the SDK: every ask for a chain gets the same client until that client is destroyed.
  h.createChainClient.mockReset().mockImplementation(({ chains }: { chains: Record<string, { genesis: string }> }) => {
    const [name, descriptor] = Object.entries(chains)[0]!;
    const asked = h.clients.get(name);
    if (asked) return asked;
    const client = fakeClient(name, descriptor.genesis);
    client.destroy.mockImplementation(() => h.clients.delete(name));
    const opening = h.hostAnswers.then(() => client);
    h.clients.set(name, opening);
    return opening;
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('getChainApis in a container', () => {
  it('asks the host whether it serves Asset Hub', async () => {
    h.supported.add(ASSET_HUB_GENESIS);

    const apis = await getChainApis();

    expect(h.isChainSupported).toHaveBeenCalledWith(ASSET_HUB_GENESIS);
    expect(apis?.assetHub).toBeDefined();
  });

  it('builds no client for a chain the host rejects', async () => {
    await expect(getChainApis()).rejects.toThrow();
    expect(h.createChainClient).not.toHaveBeenCalled();
  });

  it('serves NFTs only when the People Chain is missing', async () => {
    h.supported.add(ASSET_HUB_GENESIS);

    const apis = await getChainApis();

    expect(apis?.assetHub).toBeDefined();
    expect(apis?.people).toBeNull();
  });

  it('warns once about the missing People Chain, not on every poll', async () => {
    h.supported.add(ASSET_HUB_GENESIS);

    await getChainApis();
    await getChainApis();
    await getChainApis();

    const missing = vi.mocked(console.warn).mock.calls.filter(([msg]) => String(msg).includes('People Chain'));
    expect(missing).toHaveLength(1);
  });

  it('picks up the People Chain when a later poll finds the host serving it', async () => {
    h.supported.add(ASSET_HUB_GENESIS);
    expect((await getChainApis())?.people).toBeNull();

    h.supported.add(PEOPLE_GENESIS);

    expect((await getChainApis())?.people).toBeDefined();
  });

  it('reports the real cause when the host cannot be asked', async () => {
    h.isChainSupported.mockResolvedValue({ ok: false, error: new h.HostUnavailableError('down') });

    await expect(getChainApis()).rejects.toBeInstanceOf(h.HostUnavailableError);
    expect(h.createChainClient).not.toHaveBeenCalled();
  });

  it('keeps Asset Hub and stays quiet when only the People probe cannot be asked', async () => {
    h.supported.add(ASSET_HUB_GENESIS);
    h.isChainSupported.mockImplementation(async (genesis: string) =>
      genesis === ASSET_HUB_GENESIS
        ? { ok: true, value: true }
        : { ok: false, error: new h.HostUnavailableError('down') },
    );

    const apis = await getChainApis();

    expect(apis?.assetHub).toBeDefined();
    expect(apis?.people).toBeNull();
    const missing = vi.mocked(console.warn).mock.calls.filter(([msg]) => String(msg).includes('People Chain'));
    expect(missing).toHaveLength(0);
  });
});

describe('chain liveness and rebuilding one chain', () => {
  const newestFinalized = (name: string) => h.finalized[name]?.at(-1);

  it('counts a chain as live only while its finalized blocks keep coming', async () => {
    h.supported.add(ASSET_HUB_GENESIS);
    await getChainApis();
    expect(isChainLive('assetHub')).toBe(false);

    newestFinalized('assetHub')?.({ hash: '0x1', number: 1 });
    expect(isChainLive('assetHub')).toBe(true);
    expect(isChainLive('assetHub', Date.now() + 61_000)).toBe(false);
  });

  it('rebuilds only the People client, and the next read builds a fresh one', async () => {
    h.supported.add(ASSET_HUB_GENESIS);
    h.supported.add(PEOPLE_GENESIS);
    const apis = await getChainApis();
    const [ahClient, peopleClient] = await Promise.all(h.createChainClient.mock.results.map((r) => r.value));

    await rebuildChain('people');

    expect(peopleClient.destroy).toHaveBeenCalledTimes(1);
    expect(ahClient.destroy).not.toHaveBeenCalled();
    expect(apis?.people).toBeNull();
    expect((await getChainApis())?.people).toBeDefined();
    expect(h.createChainClient).toHaveBeenCalledTimes(3);
  });

  it('replaces the Asset Hub client in place and leaves People alone', async () => {
    h.supported.add(ASSET_HUB_GENESIS);
    h.supported.add(PEOPLE_GENESIS);
    const apis = await getChainApis();
    const before = apis?.assetHub;
    const [ahClient, peopleClient] = await Promise.all(h.createChainClient.mock.results.map((r) => r.value));

    await rebuildChain('assetHub');

    expect(ahClient.destroy).toHaveBeenCalledTimes(1);
    expect(peopleClient.destroy).not.toHaveBeenCalled();
    expect(apis?.assetHub).toBeDefined();
    expect(apis?.assetHub).not.toBe(before);
    expect(apis?.people).toBeDefined();
  });
});

describe('getChainApis outside a host', () => {
  it('opens no connection: the chain layer stays inert', async () => {
    h.state.inContainer = false;

    expect(await getChainApis()).toBeNull();
    expect(h.createChainClient).not.toHaveBeenCalled();
  });
});

describe('results the host never gives', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A promise the test never settles: a result the host never gives. */
  const never = () => new Promise<never>(() => {});

  it('returns an Asset Hub read without waiting for a People Chain probe', async () => {
    h.supported.add(ASSET_HUB_GENESIS);
    h.isChainSupported.mockImplementation((genesis: string) =>
      genesis === ASSET_HUB_GENESIS ? Promise.resolve({ ok: true, value: true }) : never(),
    );

    const apis = await getChainApis({ waitForPeople: false });

    expect(apis?.assetHub).toBeDefined();
    expect(apis?.people).toBeNull();
  });

  it('gives up on a People Chain probe that never returns, and asks again on the next read', async () => {
    vi.useFakeTimers();
    h.supported.add(ASSET_HUB_GENESIS);
    h.supported.add(PEOPLE_GENESIS);
    let hang = true;
    h.isChainSupported.mockImplementation((genesis: string) =>
      genesis === PEOPLE_GENESIS && hang ? never() : Promise.resolve({ ok: true, value: h.supported.has(genesis) }),
    );

    const first = getChainApis().catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(String(await first)).toMatch(/People Chain timed out/);

    hang = false;
    expect((await getChainApis())?.people).toBeDefined();
  });

  it('gives up on a connection that never opens, and the next read uses it once it opens', async () => {
    vi.useFakeTimers();
    h.supported.add(ASSET_HUB_GENESIS);
    let answer!: () => void;
    h.hostAnswers = new Promise((resolve) => {
      answer = resolve;
    });

    const first = getChainApis({ waitForPeople: false }).catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(String(await first)).toMatch(/opening the chain connection timed out/);

    const second = getChainApis({ waitForPeople: false });
    answer();
    expect((await second)?.assetHub).toBeDefined();
    h.finalized.assetHub![0]!({ hash: '0x1', number: 1 });

    // Both reads got the one client: it stays open and is followed once.
    await vi.advanceTimersByTimeAsync(0);
    const client = await h.createChainClient.mock.results[0]!.value;
    expect(client.destroy).not.toHaveBeenCalled();
    expect(h.finalized.assetHub).toHaveLength(1);
    expect(isChainLive('assetHub')).toBe(true);
  });
});
