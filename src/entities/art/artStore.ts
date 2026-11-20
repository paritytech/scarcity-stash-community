// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// Verified pictures and manifests kept on this device (IndexedDB), so a restart,
// even offline, shows every picture seen before. Bytes are checked against their
// CID again on the way out (verifiedArt.ts), so a bad row costs a fetch, never a
// wrong picture. Everything stays under CEILING_BYTES, least recently shown rows
// going first; `meta` keeps each row's age apart from its bytes, so a read
// refreshes it cheaply. `cells` holds the grid's 64 px copies (grid/art.ts).

import { txDone } from '@/shared/lib/idb';

const DB_NAME = 'pkt_art';
const DB_VERSION = 2;
const STORE = 'art';
const META = 'meta';
const CELLS = 'cells';
const AT_INDEX = 'at';
/** The most small copies kept: a few MB of pixels, read back whole at launch. */
const MAX_CELLS = 400;
/** The most this store holds. Room for many multi-MB pictures, and
 *  well inside what a phone grants one origin. */
const CEILING_BYTES = 200 * 1024 * 1024;
/** How long an open may stay silent before the store counts as absent: some
 *  WebViews never complete `indexedDB.open`, and every picture waits on it. */
const OPEN_MS = 5_000;

interface ArtRow {
  cid: string;
  bytes: Uint8Array<ArrayBuffer>;
  type: string;
}

interface MetaRow {
  cid: string;
  /** When the picture was last read (ms): the eviction order. */
  at: number;
  size: number;
}

export interface StoredArt {
  bytes: Uint8Array<ArrayBuffer>;
  type: string;
}

/** A small copy the grid made of a picture: its pixels, the colour of the dot
 *  it shrinks to and the empty space under it, by the URL the grid draws. */
export interface KeptCell {
  url: string;
  rgba: Uint8Array<ArrayBuffer>;
  color: string;
  gap: number;
}

interface CellRow extends KeptCell {
  /** When it was kept (ms): the oldest go first past MAX_CELLS. */
  at: number;
}

/** The one connection, memoised; null (and kept null) where IndexedDB is
 *  missing, rejected or silent, so a doomed open is not retried on every picture. */
let dbp: Promise<IDBDatabase | null> | null = null;
let persistAsked = false;

function openDb(): Promise<IDBDatabase | null> {
  if (dbp) return dbp;
  dbp = new Promise((resolve) => {
    try {
      const factory = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
      if (!factory) {
        resolve(null);
        return;
      }
      const req = factory.open(DB_NAME, DB_VERSION);
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        resolve(null);
      }, OPEN_MS);
      const settle = (db: IDBDatabase | null) => {
        clearTimeout(timer);
        // An open that lands after the wait already returned "no store".
        if (settled) return db?.close();
        settled = true;
        resolve(db);
      };
      req.onupgradeneeded = (event) => {
        const db = req.result;
        if (event.oldVersion < 1) {
          db.createObjectStore(STORE, { keyPath: 'cid' });
          db.createObjectStore(META, { keyPath: 'cid' }).createIndex(AT_INDEX, 'at');
        }
        if (event.oldVersion < 2) db.createObjectStore(CELLS, { keyPath: 'url' }).createIndex(AT_INDEX, 'at');
      };
      req.onsuccess = () => {
        // The browser may close a connection at any time; the next op reopens.
        req.result.onclose = () => {
          dbp = null;
        };
        settle(req.result);
      };
      req.onerror = () => settle(null);
      req.onblocked = () => settle(null);
    } catch {
      resolve(null);
    }
  });
  return dbp;
}

/** The picture kept for `cid`, or null on a miss or any storage trouble. A hit
 *  refreshes the row's age. */
export async function getArt(cid: string): Promise<StoredArt | null> {
  const db = await openDb();
  if (!db) return null;
  try {
    const row = await new Promise<ArtRow | null>((resolve) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(cid);
      req.onsuccess = () => resolve((req.result as ArtRow | undefined) ?? null);
      req.onerror = () => resolve(null);
    });
    if (!row || !(row.bytes instanceof Uint8Array) || typeof row.type !== 'string') return null;
    void touch(db, cid);
    return { bytes: row.bytes, type: row.type };
  } catch {
    return null;
  }
}

/** Refreshes `at`, so the least recently read rows go first. Not awaited: a lost
 *  touch only mis-ages one row, and that matters only under disk pressure. */
async function touch(db: IDBDatabase, cid: string): Promise<void> {
  try {
    const tx = db.transaction(META, 'readwrite');
    const store = tx.objectStore(META);
    const req = store.get(cid);
    req.onsuccess = () => {
      const row = req.result as MetaRow | undefined;
      if (row) {
        row.at = Date.now();
        store.put(row);
      }
    };
    await txDone(tx);
  } catch {
    // the read already returned; the row just keeps its old age
  }
}

/** Keeps verified bytes for `cid` under the ceiling. Never throws; on a full
 *  disk the oldest rows make room once, then it gives up. */
export async function putArt(cid: string, bytes: Uint8Array<ArrayBuffer>, type: string): Promise<void> {
  try {
    if (bytes.length > CEILING_BYTES) return;
    const db = await openDb();
    if (!db) return;
    const row: ArtRow = { cid, bytes, type };
    const meta: MetaRow = { cid, at: Date.now(), size: bytes.length };
    let wrote = await tryPut(db, row, meta);
    if (wrote === 'quota') {
      await evictOldest(db, bytes.length, cid);
      wrote = await tryPut(db, row, meta);
    }
    if (wrote === 'ok' && !persistAsked) {
      persistAsked = true;
      // Ask the browser not to sweep this origin's storage; a no-op where unsupported.
      const nav = (globalThis as { navigator?: { storage?: { persist?: () => Promise<boolean> } } }).navigator;
      void nav?.storage?.persist?.().catch(() => {});
    }
  } catch {
    // kept nothing: the next session fetches as before
  }
}

/** Writes both rows in one transaction, first evicting the oldest rows the
 *  ceiling has no room for, never this cid's own older copy. */
async function tryPut(db: IDBDatabase, row: ArtRow, meta: MetaRow): Promise<'ok' | 'quota' | 'failed'> {
  try {
    const tx = db.transaction([STORE, META], 'readwrite');
    const sizes = tx.objectStore(META).getAll();
    sizes.onsuccess = () => {
      const kept = (sizes.result as MetaRow[]).reduce((sum, r) => (r.cid === meta.cid ? sum : sum + r.size), 0);
      const write = () => {
        tx.objectStore(STORE).put(row);
        tx.objectStore(META).put(meta);
      };
      const over = kept + meta.size - CEILING_BYTES;
      if (over > 0) evict(tx, over, meta.cid, write);
      else write();
    };
    const failure = await txDone(tx);
    if (!failure) return 'ok';
    return failure.name === 'QuotaExceededError' ? 'quota' : 'failed';
  } catch {
    return 'failed';
  }
}

/** Walk `meta` least recently shown first inside `tx`, dropping rows (never
 *  `keep`'s) until `bytes` are freed or the store is empty, then `then`. */
function evict(tx: IDBTransaction, bytes: number, keep: string, then: () => void): void {
  const art = tx.objectStore(STORE);
  const walker = tx.objectStore(META).index(AT_INDEX).openCursor();
  let toFree = bytes;
  walker.onsuccess = () => {
    const cursor = walker.result;
    if (!cursor || toFree <= 0) {
      then();
      return;
    }
    const row = cursor.value as MetaRow;
    if (row.cid !== keep) {
      toFree -= row.size;
      art.delete(row.cid);
      cursor.delete();
    }
    cursor.continue();
  };
}

/** Frees `bytes` of the oldest rows in a transaction of its own, so a rejected
 *  write can be tried once more. Resolves either way. */
function evictOldest(db: IDBDatabase, bytes: number, keep: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction([STORE, META], 'readwrite');
      evict(tx, bytes, keep, () => {});
      void txDone(tx).then(() => resolve());
    } catch {
      resolve();
    }
  });
}

/** Forget `cid`'s row: its bytes no longer match the CID (verifiedArt.ts). */
export async function removeArt(cid: string): Promise<void> {
  try {
    const db = await openDb();
    if (!db) return;
    const tx = db.transaction([STORE, META], 'readwrite');
    tx.objectStore(STORE).delete(cid);
    tx.objectStore(META).delete(cid);
    await txDone(tx);
  } catch {
    // already gone, or storage is failing: either way nothing to keep
  }
}

/** Every small copy kept, oldest first; none when the store cannot be read.
 *  The caller checks each one's size and colour before drawing it. */
export async function readCells(): Promise<KeptCell[]> {
  const db = await openDb();
  if (!db) return [];
  try {
    const rows = await new Promise<unknown[]>((resolve) => {
      const req = db.transaction(CELLS, 'readonly').objectStore(CELLS).index(AT_INDEX).getAll();
      req.onsuccess = () => resolve(req.result as unknown[]);
      req.onerror = () => resolve([]);
    });
    const cells: KeptCell[] = [];
    for (const row of rows) {
      const r = row as Partial<CellRow> | null;
      if (typeof r?.url !== 'string' || !(r.rgba instanceof Uint8Array)) continue;
      if (typeof r.color !== 'string' || typeof r.gap !== 'number') continue;
      cells.push({ url: r.url, rgba: r.rgba, color: r.color, gap: r.gap });
    }
    return cells;
  } catch {
    return [];
  }
}

/** Keeps small copies, each replacing its URL's older one; past MAX_CELLS the
 *  oldest go. Never throws. */
export async function keepCells(cells: readonly KeptCell[]): Promise<void> {
  if (cells.length === 0) return;
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(CELLS, 'readwrite');
    const store = tx.objectStore(CELLS);
    const at = Date.now();
    for (const cell of cells) store.put({ ...cell, at } satisfies CellRow);
    const count = store.count();
    count.onsuccess = () => {
      let over = count.result - MAX_CELLS;
      if (over <= 0) return;
      const oldest = store.index(AT_INDEX).openCursor();
      oldest.onsuccess = () => {
        const cursor = oldest.result;
        if (!cursor || over <= 0) return;
        cursor.delete();
        over -= 1;
        cursor.continue();
      };
    };
    await txDone(tx);
  } catch {
    // kept nothing: the next launch makes them again
  }
}
