// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// Which collection a credit will mint into. The player selects it in Jollity,
// which keeps its selections in its own host storage under `jollity.chest`, as
// `{ "0x<credit>": { collectionId, selectedAt } }`. The newest selection wins,
// and a credit without one goes to the player's top favourite, else to an
// approved collection worked out from its hash. Host storage is per device.

import { asProductId, formatHostError, fromHex, getTruApi } from '@parity/product-sdk-host';

import { OFFERED_COLLECTIONS } from '@/entities/collections/approvedCollections';
import { favouriteCollections, getOfferedCollections, type MintCollectionVM } from '@/entities/collections/registry';
import type { SelectedCollection } from '@/entities/nfts/collectibles';
import { DOTNS_IDENTIFIER, DOTNS_TLDS } from '@/shared/chain/product';
import { isInContainer } from '@/shared/host/embed';
import { withDeadline } from '@/shared/lib/deadline';
import { normalizeHash } from '@/shared/lib/hash';

const JOLLITY_KEY = 'jollity.chest';

/** Jollity's release name, then its staging name. */
const JOLLITY_LABELS = ['dim2', 'dim2next'];

/** A host call that never returns is given up, so the next read can start. */
const HOST_DEADLINE_MS = 8_000;

const decoder = new TextDecoder();

type TruApi = NonNullable<Awaited<ReturnType<typeof getTruApi>>>;

/** A selection as Jollity stores it. One stored before times were kept has none. */
interface StoredSelection {
  /** The chain's collection id. */
  collectionId: number;
  /** When it was made, Unix milliseconds. */
  selectedAt?: number;
}

/** A stored selection and the product it was made in, such as `dim2.paseo`. */
export interface Selection extends StoredSelection {
  selectedBy: string;
}

/** The selections in one stored value, by normalized credit hash. A malformed
 *  entry drops out, and a malformed time is left off. */
export function parseSelections(value: unknown): Map<string, StoredSelection> {
  const selections = new Map<string, StoredSelection>();
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return selections;
  for (const [credit, stored] of Object.entries(value)) {
    const hash = normalizeHash(credit);
    const { collectionId, selectedAt } = (stored ?? {}) as { collectionId?: unknown; selectedAt?: unknown };
    if (!/^[0-9a-f]{64}$/.test(hash)) continue;
    if (typeof collectionId !== 'number' || !Number.isInteger(collectionId) || collectionId < 0) continue;
    const timed = typeof selectedAt === 'number' && Number.isFinite(selectedAt) && selectedAt > 0;
    selections.set(hash, { collectionId, ...(timed ? { selectedAt } : {}) });
  }
  return selections;
}

/** Jollity's names on this host's network, which shares this app's TLD. An id
 *  with no network TLD, such as a localhost harness, reads paseo's. */
export function jollityProductIds(ownId: string = DOTNS_IDENTIFIER): string[] {
  const last = ownId.split('.').pop() ?? '';
  const tld = DOTNS_TLDS.includes(last) ? last : 'paseo';
  return JOLLITY_LABELS.map((label) => `${label}.${tld}`);
}

type ProductRead = { product: string; selections: Map<string, StoredSelection> } | { product: string; failure: string };

/** The selections Jollity keeps under one of its names. Jollity's manifest
 *  grants the label `stash` the storage scope to read them. */
async function fetchJollitySelections(truApi: TruApi, product: string): Promise<ProductRead> {
  try {
    const stored = await withDeadline(
      truApi.localStorage.read({ product: asProductId(product), key: JOLLITY_KEY }).match(
        (response) => ({ value: response.value }),
        (error) => ({ failure: formatHostError(error) }),
      ),
      HOST_DEADLINE_MS,
      `reading ${product}`,
    );
    if ('failure' in stored) return { product, failure: stored.failure };
    if (stored.value === undefined) return { product, selections: new Map() };
    return { product, selections: parseSelections(JSON.parse(decoder.decode(fromHex(stored.value)))) };
  } catch (err) {
    return { product, failure: err instanceof Error ? err.message : String(err) };
  }
}

/** Every selection Jollity stored on this device for the player's credits, the
 *  newest of each, by normalized credit hash. Null outside a host and when one
 *  of Jollity's names could not be read, so no NFT is minted from a credit on a guess.
 *  Never rejects. */
export async function fetchSelections(): Promise<Map<string, Selection> | null> {
  if (!isInContainer) return null;
  const truApi = await withDeadline(getTruApi(), HOST_DEADLINE_MS, 'host client').catch(() => null);
  if (!truApi) return null;
  const reads = await Promise.all(jollityProductIds().map((product) => fetchJollitySelections(truApi, product)));

  const newest = new Map<string, Selection>();
  const lines: string[] = [];
  // A name that failed for any reason but no grant leaves the read incomplete.
  let complete = true;
  for (const read of reads) {
    if ('failure' in read) {
      const refused = read.failure === 'AccessNotGranted';
      if (!refused) complete = false;
      lines.push(`${read.product} ${refused ? 'not granted' : read.failure}`);
      continue;
    }
    lines.push(`${read.product} ${read.selections.size} selections`);
    for (const [hash, stored] of read.selections) {
      const have = newest.get(hash);
      // One without a time counts as the oldest, and of two equally old the release name's stands.
      if (!have || (stored.selectedAt ?? 0) > (have.selectedAt ?? 0)) {
        newest.set(hash, { ...stored, selectedBy: read.product });
      }
    }
  }
  console.info(`[selections] ${lines.join(', ')}`);
  return complete ? newest : null;
}

/** A stable index from a credit hash. Jollity must derive it the same way, or
 *  the credit goes to a different collection in each app. */
function indexFor(hash: string, size: number): number {
  const hex = normalizeHash(hash);
  if (size <= 0) return 0;
  let acc = 0;
  for (let i = 0; i < 8 && i * 2 + 1 < hex.length; i++) {
    const byte = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    acc = (acc * 31 + (Number.isFinite(byte) ? byte : 0)) >>> 0;
  }
  return acc % size;
}

/** The collection a credit goes to with no selection: the top favourite, else
 *  one of the approved ones, worked out from the credit so a favourite never moves it. */
function defaultCollectionFor(hash: string, offered: readonly MintCollectionVM[]): MintCollectionVM | undefined {
  const favourite = favouriteCollections()
    .map((id) => offered.find((c) => c.id === id))
    .find(Boolean);
  if (favourite) return favourite;
  const approved = offered.filter((c) => OFFERED_COLLECTIONS.has(c.chainId));
  const from = approved.length > 0 ? approved : offered;
  return from[indexFor(hash, from.length)];
}

/** Where each of `credits` goes: its stored selection when that is on an
 *  offered collection, else its default. Null while no collection is offered:
 *  nothing can be decided yet. */
export function selectCollections(
  credits: readonly { hash: string }[],
  stored: ReadonlyMap<string, Selection>,
): Map<string, SelectedCollection> | null {
  const offered = getOfferedCollections();
  if (offered.length === 0) return null;
  const selected = new Map<string, SelectedCollection>();
  for (const credit of credits) {
    const hash = normalizeHash(credit.hash);
    const selection = stored.get(hash);
    if (selection && offered.some((c) => c.chainId === selection.collectionId)) {
      selected.set(hash, {
        selectedCollectionId: String(selection.collectionId),
        selectedBy: selection.selectedBy,
        ...(selection.selectedAt === undefined ? {} : { selectedAt: selection.selectedAt }),
      });
      continue;
    }
    const fallback = defaultCollectionFor(hash, offered);
    if (fallback) selected.set(hash, { selectedCollectionId: fallback.id });
  }
  return selected;
}
