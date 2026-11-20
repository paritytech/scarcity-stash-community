// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// The player is named from this app's own account at the host. A host with no
// session yet is asked again, on a schedule and the moment its account
// connects, until it returns the account.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ALICE_42 } from '@/testing/fixtures';

type ConnectionStatus = 'Connected' | 'Disconnected';

const host = vi.hoisted(() => ({
  own: vi.fn<() => Promise<string | null>>(),
  productAccount: vi.fn(),
  unsubscribe: vi.fn(),
  connection: null as ((status: ConnectionStatus) => void) | null,
}));

vi.mock('@/shared/host/embed', () => ({ isInContainer: true, ownAccountAddress: host.own }));
vi.mock('@/shared/lib/deadline', () => ({
  withDeadline: <T>(promise: Promise<T>) => promise,
}));
vi.mock('@parity/product-sdk-host', () => ({
  getAccountsProvider: async () => ({
    getProductAccount: host.productAccount,
    subscribeAccountConnectionStatus: (callback: (status: ConnectionStatus) => void) => {
      host.connection = callback;
      return { unsubscribe: host.unsubscribe, onInterrupt: () => () => {} };
    },
  }),
}));

/** A fresh page: the identity module starts unnamed. */
async function boot() {
  vi.resetModules();
  const identity = await import('./identity');
  await identity.initIdentity();
  return identity;
}

beforeEach(() => {
  vi.useFakeTimers();
  host.own.mockReset();
  host.connection = null;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('naming the player in a host', () => {
  it("names the player from the app's account at the host", async () => {
    host.own.mockResolvedValue(ALICE_42);
    const { getPlayerAddress } = await boot();
    expect(getPlayerAddress()).toBe(ALICE_42);
  });

  it('gives the saved form of the records owner, and nothing before the player is named', async () => {
    host.own.mockResolvedValue(null);
    const unnamed = await boot();
    expect(unnamed.recordsOwner()).toBe('');
    host.own.mockResolvedValue(ALICE_42);
    const named = await boot();
    expect(named.recordsOwner()).toBe(`a:${ALICE_42}|`);
  });

  it('leaves the player unnamed while the host has no session, and never takes a product account instead', async () => {
    host.own.mockResolvedValue(null);
    const { getPlayerAddress } = await boot();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(getPlayerAddress()).toBeNull();
    expect(host.productAccount).not.toHaveBeenCalled();
  });

  it('asks again on a schedule and names the player once the host returns the account', async () => {
    host.own.mockResolvedValue(null);
    const { getPlayerAddress, subscribePlayer } = await boot();
    const seen: unknown[] = [];
    subscribePlayer((address) => seen.push(address));
    host.own.mockResolvedValue(ALICE_42);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(getPlayerAddress()).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(getPlayerAddress()).toBe(ALICE_42);
    expect(seen).toEqual([null, ALICE_42]);
    expect(host.unsubscribe).toHaveBeenCalledOnce();
  });

  it("asks at once when the host's account connects", async () => {
    host.own.mockResolvedValue(null);
    const { getPlayerAddress } = await boot();
    await vi.advanceTimersByTimeAsync(0);
    host.own.mockResolvedValue(ALICE_42);

    host.connection?.('Disconnected');
    await vi.advanceTimersByTimeAsync(0);
    expect(getPlayerAddress()).toBeNull();
    host.connection?.('Connected');
    await vi.advanceTimersByTimeAsync(0);
    expect(getPlayerAddress()).toBe(ALICE_42);
  });

  it('stops asking once the player is named', async () => {
    host.own.mockResolvedValue(null);
    await boot();
    host.own.mockResolvedValue(ALICE_42);
    await vi.advanceTimersByTimeAsync(2_000);
    const asked = host.own.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(host.own.mock.calls.length).toBe(asked);
  });
});
