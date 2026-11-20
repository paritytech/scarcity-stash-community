// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// The collections as this device last knew them, and the player's favourites,
// read back before the first frame. The registry reads the chain again in the
// background and writes here only what is new.

import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';
import { createStore } from 'zustand/vanilla';

import { stateStorage } from '@/shared/lib/stateStorage';

/** One collection as the chain registers it for claims. */
export interface KnownCollection {
  id: number;
  name?: string;
  /** How many items it defines, when the chain record has it. */
  itemCount?: number;
}

export interface KeptCollections {
  /** The last list the chain gave, in its order. */
  known: readonly KnownCollection[];
  /** The player's favourite collections by the UI's string id, most liked first. */
  favourites: readonly string[];
}

interface CollectionsState extends KeptCollections {
  /** A read of the chain landed with `list`. */
  read: (list: readonly KnownCollection[]) => void;
}

const KEY = 'pkt_collections_v1';
const VERSION = 1;
const EMPTY: KeptCollections = { known: [], favourites: [] };

/** The collections store over `storage`. The saved collections are read by
 *  `persist.rehydrate()` (app/main.tsx). */
export function createCollectionsStore(storage: StateStorage) {
  return createStore<CollectionsState>()(
    persist(
      (set, get) => ({
        ...EMPTY,
        read: (list) => {
          const known = usableKnown(list);
          if (!sameKnown(known, get().known)) set({ known });
        },
      }),
      {
        name: KEY,
        version: VERSION,
        storage: createJSONStorage(() => storage),
        skipHydration: true,
        partialize: ({ known, favourites }): KeptCollections => ({ known, favourites }),
        // A kept store of another shape is dropped and read again from the chain.
        migrate: () => EMPTY,
        merge: (kept, current) => ({ ...current, ...usableKept(kept) }),
      },
    ),
  );
}

/** The kept part as far as it is well formed. */
function usableKept(kept: unknown): KeptCollections {
  if (!kept || typeof kept !== 'object') return EMPTY;
  const k = kept as Partial<Record<keyof KeptCollections, unknown>>;
  return { known: usableKnown(k.known), favourites: usableFavourites(k.favourites) };
}

/** Collections with a whole id, each id once; a malformed name or size drops
 *  out on its own. */
function usableKnown(raw: unknown): KnownCollection[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<number>();
  const known: KnownCollection[] = [];
  for (const c of raw as unknown[]) {
    if (!c || typeof c !== 'object') continue;
    const { id, name, itemCount } = c as Record<string, unknown>;
    if (typeof id !== 'number' || !Number.isInteger(id) || id < 0 || seen.has(id)) continue;
    seen.add(id);
    known.push({
      id,
      ...(typeof name === 'string' ? { name } : {}),
      ...(typeof itemCount === 'number' && Number.isInteger(itemCount) && itemCount >= 0 ? { itemCount } : {}),
    });
  }
  return known;
}

/** Collection ids in their string form, each once. */
function usableFavourites(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set((raw as unknown[]).filter((id): id is string => typeof id === 'string' && /^\d+$/.test(id)))];
}

function sameKnown(a: readonly KnownCollection[], b: readonly KnownCollection[]): boolean {
  return (
    a.length === b.length &&
    a.every((c, i) => {
      const d = b[i]!;
      return c.id === d.id && c.name === d.name && c.itemCount === d.itemCount;
    })
  );
}

export const collectionsStore = createCollectionsStore(stateStorage);
