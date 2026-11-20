// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// The catalogue of every collection the grid shows, read from chain, kept for
// the session and in host storage for the first frame. Reads run two at a time,
// since each fetches a manifest per item; a read is fresh for a minute and a
// refresh keeps the last one on screen. A failed read retries on the registry's
// schedule.

import { getChainApis } from '@/shared/chain/client';
import { isLostBlock, READ_AGAIN_MS } from '@/shared/chain/lostBlock';
import { createObservable } from '@/shared/lib/observable';
import { stateStorage } from '@/shared/lib/stateStorage';

import { type CatalogueItem, fetchCatalogue } from './catalogue';
import { RETRY_DELAYS_MS, RETRY_STEADY_MS } from './registry';

export interface CatalogueSlot {
  /** The last good read, or null before the first one. */
  items: CatalogueItem[] | null;
  /** `failed` lasts through the retries, until a read lands; `skipped` was too
   *  large to read whole, so the grid shows only what the player holds from it. */
  status: 'loading' | 'ready' | 'failed' | 'skipped';
}

/** A collection defining more items than this is not read whole: the pieces
 *  the player holds show without the rest of the set. */
const CATALOGUE_CAP = 600;

const FRESH_MS = 60_000;
const PARALLEL = 2;
const STORE_KEY = 'pkt_catalogues_v1';
/** Metadata keys worth saving: what the grid and the detail read. The rest
 *  arrive with the next read. */
const KEPT_KEYS = new Set(['manifest', 'rarities', 'rarity', 'description', 'archetype']);

const slots = createObservable<Readonly<Record<string, CatalogueSlot>>>({});
const readAt = new Map<string, number>();
const failures = new Map<string, number>();
/** Collections whose read lost its block and started again: until one lands,
 *  a second loss is a failure like any other. */
const readAgain = new Set<string>();
const retryTimers = new Map<string, number>();
const queue: string[] = [];
/** The collections a read is running for. */
const reading = new Set<string>();

/** Subscribe to every catalogue slot; called at once with the current ones. */
export const subscribeCatalogues = (cb: (s: Readonly<Record<string, CatalogueSlot>>) => void): (() => void) =>
  slots.subscribe(cb);

/** Every catalogue slot now, the same object until one changes. */
export const currentCatalogues = (): Readonly<Record<string, CatalogueSlot>> => slots.get();

/** Whether the grid can lay a collection out from `slot`: a read is in, kept
 *  or fresh, or the read gave up or was skipped. */
export const catalogueReady = (slot: CatalogueSlot | undefined): boolean =>
  slot !== undefined && (slot.items !== null || slot.status !== 'loading');

/** Read the catalogues of `ids` that are not fresh, in the order given. A
 *  collection whose `sizes` entry exceeds CATALOGUE_CAP is marked skipped. */
export function ensureCatalogues(
  ids: readonly string[],
  sizes: Readonly<Record<string, number | undefined>> = {},
): void {
  const now = Date.now();
  for (const id of ids) {
    if (!/^\d+$/.test(id)) continue;
    const size = sizes[id];
    if (typeof size === 'number' && size > CATALOGUE_CAP) {
      if (slots.get()[id]?.status !== 'skipped') put(id, { items: null, status: 'skipped' });
      continue;
    }
    const at = readAt.get(id);
    if (at !== undefined && now - at < FRESH_MS) continue;
    if (queue.includes(id) || reading.has(id) || retryTimers.has(id)) continue;
    queue.push(id);
  }
  pump();
}

/** Forget freshness so the next ensureCatalogues reads everything again, e.g.
 *  when the app comes back to the front. */
export function staleCatalogues(): void {
  readAt.clear();
}

async function loadCatalogue(collectionId: number): Promise<CatalogueItem[]> {
  const apis = await getChainApis();
  if (!apis) throw new Error('no chain connection this session');
  return fetchCatalogue(apis, collectionId);
}

function pump(): void {
  while (reading.size < PARALLEL && queue.length > 0) {
    const id = queue.shift()!;
    reading.add(id);
    // A retry leaves the slot `failed`.
    if (!failures.has(id)) put(id, { items: slots.get()[id]?.items ?? null, status: 'loading' });
    loadCatalogue(Number(id))
      .then(
        (items) => {
          readAt.set(id, Date.now());
          failures.delete(id);
          readAgain.delete(id);
          put(id, { items, status: 'ready' });
          persist();
        },
        (e: unknown) => {
          if (!readAgain.has(id) && isLostBlock(e)) {
            readAgain.add(id);
            console.info('[catalogue]', id, 'lost its block; reading again at the newest');
            retryTimers.set(
              id,
              window.setTimeout(() => {
                retryTimers.delete(id);
                queue.push(id);
                pump();
              }, READ_AGAIN_MS),
            );
            return;
          }

          console.warn('[catalogue]', id, e instanceof Error ? e.message : String(e));
          const lost = (failures.get(id) ?? 0) + 1;
          failures.set(id, lost);
          put(id, { items: slots.get()[id]?.items ?? null, status: 'failed' });
          const delay = RETRY_DELAYS_MS[lost - 1] ?? RETRY_STEADY_MS;
          retryTimers.set(
            id,
            window.setTimeout(() => {
              retryTimers.delete(id);
              ensureCatalogues([id]);
            }, delay),
          );
        },
      )
      .finally(() => {
        reading.delete(id);
        pump();
      });
  }
}

function put(id: string, slot: CatalogueSlot): void {
  slots.set({ ...slots.get(), [id]: slot });
}

function trim(item: CatalogueItem): CatalogueItem {
  if (!item.metadata) return item;
  const metadata: Record<string, string> = {};
  for (const [k, v] of Object.entries(item.metadata)) if (KEPT_KEYS.has(k)) metadata[k] = v;
  return { ...item, metadata };
}

function persist(): void {
  const out: Record<string, CatalogueItem[]> = {};
  for (const [id, slot] of Object.entries(slots.get())) if (slot.items) out[id] = slot.items.map(trim);
  void stateStorage.setItem(STORE_KEY, JSON.stringify(out));
}

/** Read the saved catalogues, before the first frame (app/main.tsx). */
export async function restoreCatalogues(): Promise<void> {
  const saved = await stateStorage.getItem(STORE_KEY);
  if (saved) slots.set(usableSlots(saved));
}

/** The saved catalogues as far as they are well formed. */
function usableSlots(saved: string): Record<string, CatalogueSlot> {
  let raw: unknown;
  try {
    raw = JSON.parse(saved);
  } catch {
    return {};
  }
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, CatalogueSlot> = {};
  for (const [id, items] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(items)) continue;
    const ok = items.filter(
      (it): it is CatalogueItem =>
        typeof it === 'object' && it !== null && typeof (it as CatalogueItem).itemIndex === 'number',
    );
    out[id] = { items: ok, status: 'ready' };
  }
  return out;
}
