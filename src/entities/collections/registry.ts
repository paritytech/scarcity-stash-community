// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// The collections a credit can mint into, from the claims pallet's minter
// registrations (minters.ts), and the player's favourites. The last list read
// is kept on this device (collectionsStore.ts) and read back before the first
// frame. The UI's ids are strings: `id === String(chainId)`.

import { createObservable } from '@/shared/lib/observable';

import { OFFERED_COLLECTIONS } from './approvedCollections';
import { collectionsStore, type KeptCollections, type KnownCollection } from './collectionsStore';
import { loadMintCollections } from './minters';

export interface MintCollectionVM {
  /** String form of the chain id, the id the UI components pass around. */
  id: string;
  /** The pallet's numeric collection id (what claimCredit takes). */
  chainId: number;
  label: string;
  /** How many distinct items this collection defines; undefined when the chain
   *  record was not read. */
  itemCount?: number;
  /** Whether a credit may mint into it: approved (approvedCollections.ts) or a
   *  favourite. The rest are listed only to name what the player holds. */
  offered: boolean;
}

/** The kept collections as the UI reads them, rebuilt whenever the store
 *  changes: a read landing, or the favourites. */
let snapshot: MintCollectionVM[] = viewsOf(collectionsStore.getState());
collectionsStore.subscribe((now, before) => {
  if (now.known !== before.known || now.favourites !== before.favourites) snapshot = viewsOf(now);
});
let inflight: Promise<MintCollectionVM[]> | null = null;

function viewsOf({ known, favourites }: KeptCollections): MintCollectionVM[] {
  const liked = new Set(favourites);
  return known.map((c) => toVM(c, OFFERED_COLLECTIONS.has(c.id) || liked.has(String(c.id))));
}

function toVM(c: KnownCollection, offered: boolean): MintCollectionVM {
  return {
    ...(typeof c.itemCount === 'number' ? { itemCount: c.itemCount } : {}),
    id: String(c.id),
    chainId: c.id,
    label: c.name?.trim() || `Collection ${c.id}`,
    offered,
  };
}

/** Fetches the registered collections and keeps them. Concurrent calls share
 *  one fetch; on failure the last list stays and the error propagates. */
export function refreshRegistry(): Promise<MintCollectionVM[]> {
  if (inflight) return inflight;
  inflight = loadMintCollections()
    .then((list) => {
      collectionsStore.getState().read(list);
      return snapshot;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** The collections as last read, or as the device kept them from an earlier
 *  read; [] before either. */
export function getRegistrySnapshot(): MintCollectionVM[] {
  return snapshot;
}

// The read is asked until it lands: at launch, then after RETRY_DELAYS_MS, then
// every RETRY_STEADY_MS.

/** Where the read stands this session. A read lost after one landed keeps
 *  `read`. */
type RegistryPhase = 'reading' | 'read';

export interface RegistryState {
  phase: RegistryPhase;
  /** Reads lost in a row before the first landed. */
  lost: number;
  /** Reads that landed; the grid re-reads names when it grows. */
  reads: number;
}

/** How long after a lost read the next one is asked, by how many were lost. */
export const RETRY_DELAYS_MS: readonly number[] = [2_000, 5_000, 10_000, 20_000, 40_000];
/** After the schedule above, how often the read is asked. */
export const RETRY_STEADY_MS = 60_000;

const initialState = (): RegistryState => ({
  phase: 'reading',
  lost: 0,
  reads: 0,
});
const state = createObservable<RegistryState>(initialState());
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let started = false;
let asking = false;

/** Calls cb with the read's state now, then on every change. */
export function subscribeRegistryState(cb: (s: RegistryState) => void): () => void {
  return state.subscribe(cb);
}

/** Whether this session's first read is still on its way: none landed, none lost. */
export function isFirstReadRunning(): boolean {
  const s = state.get();
  return s.phase === 'reading' && s.lost === 0;
}

function clearRetry(): void {
  if (retryTimer !== null) clearTimeout(retryTimer);
  retryTimer = null;
}

function scheduleRetry(): void {
  clearRetry();
  const delay = RETRY_DELAYS_MS[state.get().lost - 1] ?? RETRY_STEADY_MS;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void ask();
  }, delay);
}

/** One read. A read already in flight is left to finish. */
async function ask(): Promise<void> {
  if (asking) return;
  asking = true;
  clearRetry();
  try {
    await refreshRegistry();
    const s = state.get();
    state.set({ ...s, phase: 'read', lost: 0, reads: s.reads + 1 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[registry] the collections could not be read:', message);
    const s = state.get();
    // After a read landed, the last list read still stands.
    if (s.phase !== 'read') {
      state.set({ ...s, lost: s.lost + 1 });
      asking = false;
      scheduleRetry();
      return;
    }
  }
  asking = false;
}

/** Start reading at launch. Safe to call again: one loop per session. */
export function startRegistry(): void {
  if (started) return;
  started = true;
  void ask();
}

/** Ask now, unless the registry has not started, a read is in flight or one has
 *  landed. App.tsx calls it when the chain sync turns healthy and the list is empty. */
export function kickRegistry(): void {
  if (!started || asking || state.get().phase === 'read') return;
  void ask();
}

/** The collections a credit may be spent into, approved or favoured, in
 *  registry order. */
export function getOfferedCollections(): MintCollectionVM[] {
  return snapshot.filter((c) => c.offered);
}

/** Every collection a credit may open in, by id, read or not: the approved
 *  ones in the order the SDK lists them, then the player's favourites. */
export function offeredCollectionIds(): string[] {
  return [...new Set([...[...OFFERED_COLLECTIONS].map(String), ...collectionsStore.getState().favourites])];
}

/** The collection with string id `id`, never undefined: an unknown id gets a
 *  neutral stand-in, since screens call this while rendering. */
export function getCollection(id: string): MintCollectionVM {
  const hit = snapshot.find((c) => c.id === id);
  if (hit) return hit;
  const n = Number(id);
  return {
    id,
    chainId: Number.isInteger(n) && n >= 0 ? n : -1,
    label: `Collection ${id}`,
    offered: false,
  };
}

/** The player's favourite collections, most liked first, read from the chain
 *  yet or not. */
export const favouriteCollections = (): readonly string[] => collectionsStore.getState().favourites;
