// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mutable seams shared with the mocked modules (hoisted above the imports).
const h = vi.hoisted(() => ({
  state: { inContainer: false },
  getAccountsProvider: vi.fn(),
}));

vi.mock('@parity/product-sdk-host', () => ({ getAccountsProvider: h.getAccountsProvider }));
vi.mock('@/shared/host/embed', () => ({
  get isInContainer() {
    return h.state.inContainer;
  },
}));
vi.mock('./product', () => ({ DOTNS_IDENTIFIER: 'test.dot' }));

import type { ChainSigner } from './signer';
import { hostProductSigner } from './signing';

const HOST_SIGNER = { id: 'host' } as unknown as ChainSigner;
const ACCOUNT = { productAccount: 0 };

/** A host AccountsProvider that resolves a product account and signs it. */
function hostThatSigns() {
  const getProductAccount = vi.fn(() => ({ match: (ok: (a: unknown) => unknown) => ok(ACCOUNT) }));
  const getProductAccountSigner = vi.fn(() => HOST_SIGNER);
  return {
    provider: { getProductAccount, getProductAccountSigner },
    getProductAccount,
    getProductAccountSigner,
  };
}

beforeEach(() => {
  h.state.inContainer = false;
  h.getAccountsProvider.mockReset();
});

describe('hostProductSigner', () => {
  it('returns null outside a host, without asking for one', async () => {
    expect(await hostProductSigner(0)).toBeNull();
    expect(h.getAccountsProvider).not.toHaveBeenCalled();
  });

  it("signs as this site's product account at that index, on the pipeline that charges PGAS", async () => {
    h.state.inContainer = true;
    const { provider, getProductAccount, getProductAccountSigner } = hostThatSigns();
    h.getAccountsProvider.mockResolvedValue(provider);

    expect(await hostProductSigner(4)).toBe(HOST_SIGNER);
    expect(getProductAccount).toHaveBeenCalledWith('test.dot', 4);
    expect(getProductAccountSigner).toHaveBeenCalledWith(ACCOUNT, { txExtVersion: 1 });
  });

  it('returns null when there is no accounts provider', async () => {
    h.state.inContainer = true;
    h.getAccountsProvider.mockResolvedValue(null);

    expect(await hostProductSigner(0)).toBeNull();
  });

  it('returns null when the host cannot resolve the product account', async () => {
    h.state.inContainer = true;
    h.getAccountsProvider.mockResolvedValue({
      getProductAccount: () => ({ match: (_ok: unknown, err: () => unknown) => err() }),
      getProductAccountSigner: vi.fn(),
    });

    expect(await hostProductSigner(0)).toBeNull();
  });
});
