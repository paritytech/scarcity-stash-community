// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

import type * as ProductSdkHost from '@parity/product-sdk-host';
import type { HostNftPurseQueryPurseRequest, NftPurseItemKey, NftPurseManager } from '@parity/product-sdk-host';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DOTNS_IDENTIFIER } from '@/shared/chain/product';
import { addressOfPublicKey } from '@/shared/chain/ss58';
import { hostError, publicKey } from '@/testing/fakeHost';

import { createPurseAccount, listAccountPublicKeys, lookUpStashPurse } from './stashPurse';

interface Purse {
  id: number;
  name: string;
}

const host = vi.hoisted(() => ({
  manager: null as null | Partial<Record<'listPurses' | 'createPurse' | 'createItems', ReturnType<typeof vi.fn>>>,
}));

vi.mock('@parity/product-sdk-host', async (importOriginal) => ({
  ...(await importOriginal<typeof ProductSdkHost>()),
  getNftPurseManager: async () => host.manager,
}));

// Lists `purses`, then `afterCreate` once a purse is created.
function hostWithPurses(purses: Purse[], created?: { id: number; afterCreate: Purse[] }) {
  let listed = purses;
  const manager = {
    listPurses: vi.fn(async () => listed),
    createPurse: vi.fn(async () => {
      if (!created) throw new Error('this host was not expected to create a purse');
      listed = created.afterCreate;
      return created.id;
    }),
  };
  host.manager = manager;
  return manager;
}

beforeEach(() => {
  host.manager = null;
});

describe('lookUpStashPurse', () => {
  it('is outsideHost when there is no host', async () => {
    expect(await lookUpStashPurse()).toEqual({ status: 'outsideHost' });
  });

  it('lists the purses this product owns', async () => {
    const purseManager = hostWithPurses([{ id: 4, name: 'stash' }]);

    await lookUpStashPurse();

    expect(purseManager.listPurses).toHaveBeenCalledWith({
      owner: { tag: 'Product', value: DOTNS_IDENTIFIER },
    });
  });

  it('uses the existing purse named stash', async () => {
    const purseManager = hostWithPurses([
      { id: 2, name: 'archive' },
      { id: 4, name: 'stash' },
    ]);

    expect(await lookUpStashPurse()).toEqual({ status: 'ready', id: 4 });
    expect(purseManager.createPurse).not.toHaveBeenCalled();
  });

  it('uses the lowest id when there are duplicate purses named stash', async () => {
    hostWithPurses([
      { id: 6, name: 'stash' },
      { id: 3, name: 'stash' },
    ]);

    expect(await lookUpStashPurse()).toEqual({ status: 'ready', id: 3 });
  });

  it('creates a purse named stash when there is none', async () => {
    const purseManager = hostWithPurses([{ id: 2, name: 'archive' }], {
      id: 7,
      afterCreate: [
        { id: 2, name: 'archive' },
        { id: 7, name: 'stash' },
      ],
    });

    expect(await lookUpStashPurse()).toEqual({ status: 'ready', id: 7 });
    expect(purseManager.createPurse).toHaveBeenCalledWith({ name: 'stash' });
  });

  it('uses the lowest id when another launch created a purse at the same moment', async () => {
    hostWithPurses([], {
      id: 7,
      afterCreate: [
        { id: 5, name: 'stash' },
        { id: 7, name: 'stash' },
      ],
    });

    expect(await lookUpStashPurse()).toEqual({ status: 'ready', id: 5 });
  });

  it('fails when the host does not list the purse it created', async () => {
    hostWithPurses([], { id: 7, afterCreate: [] });

    await expect(lookUpStashPurse()).rejects.toThrow('the host created purse 7 but lists no stash purse');
  });

  it('is hostWithoutPurses when the host returns Unsupported', async () => {
    const purseManager = hostWithPurses([]);
    purseManager.listPurses.mockRejectedValue(hostError('Unsupported'));

    expect(await lookUpStashPurse()).toEqual({ status: 'hostWithoutPurses' });
  });

  it('throws any other error of the host', async () => {
    const purseManager = hostWithPurses([]);
    purseManager.listPurses.mockRejectedValue(hostError('Denied'));

    await expect(lookUpStashPurse()).rejects.toThrow('Denied');
  });
});

describe('createPurseAccount', () => {
  it('creates one account in the purse and returns its address', async () => {
    const createItems = vi.fn(async () => [publicKey(7)]);
    host.manager = { createItems };

    expect(await createPurseAccount(4)).toBe(addressOfPublicKey(publicKey(7)));
    expect(createItems).toHaveBeenCalledWith({ purse: 4, count: 1 });
  });

  it('throws when there is no host', async () => {
    await expect(createPurseAccount(4)).rejects.toThrow('not inside a Polkadot host');
  });
});

// Returns `pages[n]` for page n, or throws it when it is an error. Only the last page has no next page.
function hostWithAccountPages(pages: (NftPurseItemKey[] | Error)[]) {
  const queryPurse = vi.fn(async ({ page }: HostNftPurseQueryPurseRequest) => {
    const items = pages[page] ?? [];
    if (items instanceof Error) throw items;
    return { items, hasNext: page + 1 < pages.length };
  });
  return { purseManager: { queryPurse } as unknown as NftPurseManager, queryPurse };
}

describe('listAccountPublicKeys', () => {
  it('asks the host for the first 100 accounts of the purse', async () => {
    const { purseManager, queryPurse } = hostWithAccountPages([[publicKey(1)]]);

    await listAccountPublicKeys(purseManager, 4);

    expect(queryPurse).toHaveBeenCalledWith({ purse: 4, page: 0, pageSize: 100 });
  });

  it('returns the public keys of a purse that fits in one page', async () => {
    const { purseManager, queryPurse } = hostWithAccountPages([[publicKey(1), publicKey(2)]]);

    expect(await listAccountPublicKeys(purseManager, 4)).toEqual([publicKey(1), publicKey(2)]);
    expect(queryPurse).toHaveBeenCalledTimes(1);
  });

  it('reads every page until the host has no next page', async () => {
    const { purseManager, queryPurse } = hostWithAccountPages([
      [publicKey(1), publicKey(2)],
      [publicKey(3)],
      [publicKey(4)],
    ]);

    expect(await listAccountPublicKeys(purseManager, 4)).toEqual([
      publicKey(1),
      publicKey(2),
      publicKey(3),
      publicKey(4),
    ]);
    expect(queryPurse).toHaveBeenLastCalledWith({ purse: 4, page: 2, pageSize: 100 });
  });

  it('returns a public key once when two pages list it', async () => {
    const { purseManager } = hostWithAccountPages([
      [publicKey(1), publicKey(2)],
      [publicKey(2), publicKey(3)],
    ]);

    expect(await listAccountPublicKeys(purseManager, 4)).toEqual([publicKey(1), publicKey(2), publicKey(3)]);
  });

  it('returns an empty list for a purse with no NFTs', async () => {
    const { purseManager } = hostWithAccountPages([[]]);

    expect(await listAccountPublicKeys(purseManager, 4)).toEqual([]);
  });

  it('throws the error of a page call that failed', async () => {
    const { purseManager } = hostWithAccountPages([[publicKey(1)], hostError('Denied')]);

    await expect(listAccountPublicKeys(purseManager, 4)).rejects.toThrow('Denied');
  });
});
