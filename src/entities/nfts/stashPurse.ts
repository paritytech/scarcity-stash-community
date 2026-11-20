// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// The Stash's NFTs are in one host purse named "stash".
// The host allows duplicates, so the lowest id is used.

import {
  asProductId,
  getNftPurseManager,
  hostErrorName,
  NFT_PURSE_MAX_PAGE_SIZE,
  type NftPurseId,
  type NftPurseItemKey,
  type NftPurseManager,
} from '@parity/product-sdk-host';

import { DOTNS_IDENTIFIER } from '@/shared/chain/product';
import { addressOfPublicKey } from '@/shared/chain/ss58';
import { withDeadline } from '@/shared/lib/deadline';

const STASH_PURSE_NAME = 'stash';
/** How long the host has to find the purse, to list its accounts, or to create one. */
export const HOST_ANSWER_DEADLINE_MS = 15_000;

export type StashPurseStatus =
  { status: 'ready'; id: NftPurseId } | { status: 'outsideHost' } | { status: 'hostWithoutPurses' };

/** Finds the stash purse, or creates it when the player has none. */
export async function lookUpStashPurse(): Promise<StashPurseStatus> {
  const purseManager = await getNftPurseManager();
  if (!purseManager) return { status: 'outsideHost' };

  try {
    const id = await withDeadline(
      findOrCreateStashPurse(purseManager),
      HOST_ANSWER_DEADLINE_MS,
      'finding the stash purse',
    );
    console.log(`[purses] the stash purse is ${id}`);
    return { status: 'ready', id };
  } catch (error) {
    if (hostErrorName(error) === 'Unsupported') return { status: 'hostWithoutPurses' };
    throw error;
  }
}

async function findOrCreateStashPurse(purseManager: NftPurseManager): Promise<NftPurseId> {
  const existing = await lowestStashPurseId(purseManager);
  if (existing !== undefined) return existing;

  // Two launches can create a purse at the same moment, so list again and take the lowest id.
  const created = await purseManager.createPurse({ name: STASH_PURSE_NAME });
  const stashPurseId = await lowestStashPurseId(purseManager);
  if (stashPurseId === undefined) {
    throw new Error(`the host created purse ${created} but lists no stash purse for ${DOTNS_IDENTIFIER}`);
  }
  return stashPurseId;
}

async function lowestStashPurseId(purseManager: NftPurseManager): Promise<NftPurseId | undefined> {
  const owner = { tag: 'Product', value: asProductId(DOTNS_IDENTIFIER) } as const;
  const ownPurses = await purseManager.listPurses({ owner });
  const stashPurseIds = ownPurses.filter((purse) => purse.name === STASH_PURSE_NAME).map((purse) => purse.id);
  return stashPurseIds.length > 0 ? Math.min(...stashPurseIds) : undefined;
}

/** Creates a new account in the purse and returns its address. The host never
 *  gives the same account twice. */
export async function createPurseAccount(purseId: NftPurseId): Promise<string> {
  const purseManager = await getNftPurseManager();
  if (!purseManager) throw new Error('not inside a Polkadot host');

  const [publicKey] = await withDeadline(
    purseManager.createItems({ purse: purseId, count: 1 }),
    HOST_ANSWER_DEADLINE_MS,
    'creating the account',
  );
  return addressOfPublicKey(publicKey!);
}

/** Returns the public keys of the purse's accounts that hold an NFT.
 *  NOTE: the host does not return an account while its NFT is being sent or moved to another purse. */
export async function listAccountPublicKeys(
  purseManager: NftPurseManager,
  purseId: NftPurseId,
): Promise<NftPurseItemKey[]> {
  // The purse can change between page calls, so an account can be listed twice or missed until the next read.
  const publicKeys = new Set<NftPurseItemKey>();

  for (let page = 0; ; page++) {
    const { items, hasNext } = await purseManager.queryPurse({
      purse: purseId,
      page,
      pageSize: NFT_PURSE_MAX_PAGE_SIZE,
    });
    for (const publicKey of items) publicKeys.add(publicKey);
    if (!hasNext) return [...publicKeys];
  }
}
