// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// Every holding, credit or NFT, one record each, saved in host storage and read
// back before the first frame. A credit and the NFT minted from it share one
// record, so a mint never moves a piece. The NFT read and the credit read each
// write only their own records; a write that changes nothing writes nothing.

import { useStore } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';
import { createStore } from 'zustand/vanilla';

import type { ResolvedCollectible } from '@/entities/art/resolver';
import type { FailureKind } from '@/shared/chain/failure';
import { normalizeHash } from '@/shared/lib/hash';
import { sameValue } from '@/shared/lib/sameValue';
import { stateStorage } from '@/shared/lib/stateStorage';

import { buildEntry, type CollectibleEntry } from './format';
import type { OwnedNft } from './types';

/** A credit as the credits read describes it. */
export interface Credit {
  /** The credit hash, normalized. */
  hash: string;
  /** The People-chain block that awarded it, which names its tree. */
  awardBlock: number;
  /** When its tree was rooted, Unix seconds; absent while it is rootless. */
  awardedAt?: number;
  /** When its tree is removed from Asset Hub, after which no NFT can be minted from it,
   *  Unix seconds; absent while it is rootless. */
  expiresAt?: number;
  /** Its root is on Asset Hub and its leaf is unclaimed: a claim can spend it. */
  claimable: boolean;
  /** Where it sits in its tree, and the proof a claim spends, once rooted. */
  leafIndex?: number;
  proof?: string[];
}

/** What the credits wait for after a read: blocks with no root yet, trees not
 *  on Asset Hub yet, and the player's leaves not claimed yet. */
export interface CreditWatch {
  rootless: number[];
  awaitingTree: number[];
  unclaimed: { block: number; leaves: number[] }[];
}

const NOTHING_WATCHED: CreditWatch = { rootless: [], awaitingTree: [], unclaimed: [] };

export interface Collectible {
  /** `c:` and the credit hash for one born as a credit, kept through its mint;
   *  `i:` and the instance, or `h:` and the item hash, for an NFT that arrived. */
  id: string;
  type: 'credit' | 'nft';
  /** When the player earned it, Unix seconds, set once: a credit's award time,
   *  which the NFT it mints into keeps; else the NFT's mint time. */
  acquiredAt?: number;
  credit?: Credit;
  /** The NFT as the NFT read describes it, or as its claim's event did until
   *  a read has. */
  nft?: OwnedNft;
  /** When this device minted it (ms). Until a read shows the NFT, a read
   *  without it leaves the record standing for a while. */
  mintedHere?: number;
  /** The collection a credit will mint into (credits/selections.ts). */
  selectedCollectionId?: string;
  /** The product that collection was selected in, such as `dim2.paseo`, and
   *  when, Unix milliseconds. A default has neither. */
  selectedBy?: string;
  selectedAt?: number;
  /** What the credit would mint in each collection read so far, by collection
   *  id (credits/collectionItems.ts). A minted record keeps them: the item of
   *  its collection draws it until a read brings its name or its picture. */
  collectionItems?: Record<string, CollectionItem>;
  /** How the last mint the app started by itself from this credit failed, and
   *  when, Unix milliseconds (features/holdings/mint.ts). */
  mintFailure?: FailureKind;
  mintFailedAt?: number;
}

/** What a credit would mint in one collection, as last read. */
export interface CollectionItem {
  /** The item as the grid draws it; null when the credit would mint nothing there. */
  item: ResolvedCollectible | null;
  /** When it was read, Unix milliseconds. */
  readAt: number;
}

/** One read: what credit `credit` would mint in collection `collectionId`. */
export interface CollectionItemRead extends CollectionItem {
  credit: string;
  collectionId: string;
}

/** The collection a credit will mint into, with the selection that put it
 *  there, if one did. */
export interface SelectedCollection {
  selectedCollectionId: string;
  selectedBy?: string;
  selectedAt?: number;
}

/** What is kept on the device. */
export interface KeptCollectibles {
  /** Whose records these are (player/identity.ts recordsOwner); '' until known. */
  owner: string;
  records: Record<string, Collectible>;
  /** The records' ids, the newest earned first. */
  order: string[];
}

export const EMPTY_KEPT: KeptCollectibles = { owner: '', records: {}, order: [] };

/** How many NFT records are kept, past which the grid would build more pieces
 *  than a phone can draw. New NFTs past it are dropped; kept ones still update. */
export const MAX_NFTS = 500;

/** How long an NFT this device minted stands while reads do not show it yet. */
export const MINT_GRACE_MS = 10 * 60_000;

/** When this session started, Unix milliseconds. What a credit would mint, when
 *  read before it, is from an earlier session and is read again; a mint that
 *  failed before it is tried again. */
export const SESSION_STARTED_AT = Date.now();

export const creditId = (hash: string): string => `c:${normalizeHash(hash)}`;
const nftId = (nft: OwnedNft): string => (nft.instance ? `i:${nft.instance}` : `h:${normalizeHash(nft.hash)}`);

/** The kept records for `owner`: the same player's as they are, another's
 *  dropped. An unknown owner takes whatever is kept. */
function forOwner(kept: KeptCollectibles, owner: string): KeptCollectibles {
  if (!owner || kept.owner === owner) return kept;
  if (!kept.owner) return { ...kept, owner };
  return { ...EMPTY_KEPT, owner };
}

/** Earned first: a credit not rooted yet is seconds old and leads, then the
 *  newest by the time it was earned; an NFT with no time trails. */
function orderOf(records: Record<string, Collectible>): string[] {
  const timeOf = (r: Collectible): number => r.acquiredAt ?? (r.type === 'credit' ? Number.POSITIVE_INFINITY : -1);
  return Object.values(records)
    .sort((a, b) => timeOf(b) - timeOf(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((r) => r.id);
}

/** The kept records with `records` in place of theirs, `kept` itself when
 *  nothing changed. */
function withRecords(kept: KeptCollectibles, records: Record<string, Collectible>): KeptCollectibles {
  const ids = Object.keys(records);
  const same = ids.length === Object.keys(kept.records).length && ids.every((id) => records[id] === kept.records[id]);
  if (same) return kept;
  const order = orderOf(records);
  const sameOrder = order.length === kept.order.length && order.every((id, i) => id === kept.order[i]);
  return { ...kept, records, order: sameOrder ? kept.order : order };
}

/** `next`, or `before` itself when they hold the same. */
const settle = (before: Collectible | undefined, next: Collectible): Collectible =>
  before && sameValue(before, next) ? before : next;

/** The record without its mint mark: a read has shown its NFT. */
function seenByRead(record: Collectible): Collectible {
  const { mintedHere: _shown, ...rest } = record;
  return rest;
}

/** The record without its failed mint: a mint from it landed. */
function withoutFailedMint(record: Collectible): Collectible {
  const { mintFailure: _failure, mintFailedAt: _failedAt, ...rest } = record;
  return rest;
}

/** `record` going to `selected`. */
function withSelected(record: Collectible, selected: SelectedCollection): Collectible {
  const { selectedCollectionId: _collection, selectedBy: _by, selectedAt: _at, ...rest } = record;
  return { ...rest, ...selected };
}

/** The records after an NFT read: each NFT found updates its record or gets
 *  one; an NFT record not found leaves unless this device just minted it. */
export function onNftsRead(kept: KeptCollectibles, owner: string, nfts: readonly OwnedNft[]): KeptCollectibles {
  const base = forOwner(kept, owner);
  const records = readNftRecords(base, nfts);
  addUnreadRecords(base, records, Date.now());
  return withRecords(base, records);
}

/** The id of the record an NFT belongs to: the record that holds the same
 *  instance, else the same item hash, else a new one. */
function createRecordLookup(records: Record<string, Collectible>): (nft: OwnedNft) => string {
  const byInstance = new Map<string, string>();
  const byHash = new Map<string, string>();
  for (const r of Object.values(records)) {
    if (!r.nft) continue;
    if (r.nft.instance) byInstance.set(r.nft.instance, r.id);
    byHash.set(normalizeHash(r.nft.hash), r.id);
  }
  return (nft) => (nft.instance && byInstance.get(nft.instance)) || byHash.get(normalizeHash(nft.hash)) || nftId(nft);
}

/** The records of the NFTs a read found, each in the record it belongs to.
 *  Past MAX_NFTS records, an NFT without a record is dropped. */
function readNftRecords(base: KeptCollectibles, nfts: readonly OwnedNft[]): Record<string, Collectible> {
  const recordOf = createRecordLookup(base.records);
  const records: Record<string, Collectible> = {};
  let nftCount = 0;
  let dropped = 0;
  for (const nft of nfts) {
    const id = recordOf(nft);
    if (records[id]) continue;
    const before = base.records[id];
    if (!before && nftCount >= MAX_NFTS) {
      dropped++;
      continue;
    }
    const acquiredAt = before?.acquiredAt ?? nft.mintedAt;
    const next: Collectible = {
      ...(before ? seenByRead(before) : { id }),
      id,
      type: 'nft',
      nft,
      ...(acquiredAt !== undefined ? { acquiredAt } : {}),
    };
    records[id] = settle(before, next);
    nftCount++;
  }
  if (dropped > 0) console.warn(`[collectibles] more than ${MAX_NFTS} NFTs; dropped ${dropped}`);
  return records;
}

/** Adds the records an NFT read leaves as they are: every credit, and an NFT
 *  this device minted moments ago that the read does not show yet. */
function addUnreadRecords(base: KeptCollectibles, records: Record<string, Collectible>, now: number): void {
  for (const r of Object.values(base.records)) {
    if (records[r.id]) continue;
    const minting = r.mintedHere !== undefined && now - r.mintedHere < MINT_GRACE_MS;
    if (r.type === 'credit' || minting) records[r.id] = r;
  }
}

/** The records after a credit read: each credit updates its record or gets
 *  one, and goes to its collection in `selected`; a credit record not brought
 *  leaves. Minted records stay as they are. */
export function onCreditsRead(
  kept: KeptCollectibles,
  owner: string,
  credits: readonly Credit[],
  selected: ReadonlyMap<string, SelectedCollection> | null,
): KeptCollectibles {
  const base = forOwner(kept, owner);
  const records: Record<string, Collectible> = {};
  for (const c of credits) {
    const id = creditId(c.hash);
    const before = base.records[id];
    if (before?.type === 'nft') {
      records[id] = before;
      continue;
    }
    const credit: Credit = { ...c, hash: normalizeHash(c.hash) };
    const acquiredAt = before?.acquiredAt ?? credit.awardedAt;
    const read: Collectible = {
      ...(before ?? { id }),
      id,
      type: 'credit',
      credit,
      ...(acquiredAt !== undefined ? { acquiredAt } : {}),
    };
    const collection = selected?.get(credit.hash);
    records[id] = settle(before, collection ? withSelected(read, collection) : read);
  }
  for (const r of Object.values(base.records)) if (r.type === 'nft' && !records[r.id]) records[r.id] = r;
  return withRecords(base, records);
}

/** A mint this device made: the credit it spent and the NFT it got. */
export interface Mint {
  credit: string;
  nft: OwnedNft;
}

/** The records after this device minted an NFT from a credit: its record becomes the NFT
 *  in place, and a record a read made for the same NFT folds into it. */
export function onMint(kept: KeptCollectibles, owner: string, mint: Mint): KeptCollectibles {
  const { credit, nft } = mint;
  const base = forOwner(kept, owner);
  const id = creditId(credit);
  const before = base.records[id];
  const key = normalizeHash(nft.hash);
  const twin = Object.values(base.records).find(
    (r) =>
      r.id !== id &&
      !!r.nft &&
      ((!!nft.instance && r.nft.instance === nft.instance) || normalizeHash(r.nft.hash) === key),
  );
  const records = Object.fromEntries(Object.entries(base.records).filter(([key]) => key !== twin?.id));
  const acquiredAt = before?.acquiredAt ?? twin?.acquiredAt ?? nft.mintedAt;
  const at = Date.now();
  records[id] = {
    ...(before ? withoutFailedMint(before) : { id }),
    id,
    type: 'nft',
    ...(before?.credit ? {} : { credit: { hash: normalizeHash(credit), awardBlock: 0, claimable: false } }),
    // Minted just now: until a read brings the chain's own time, the mint's
    // stands in, so the piece counts as arrived today at once.
    nft: twin?.nft ?? (nft.lastMoved === undefined ? { ...nft, lastMoved: Math.floor(at / 1000) } : nft),
    // A read already showed it: nothing to wait for.
    ...(twin ? {} : { mintedHere: at }),
    ...(acquiredAt !== undefined ? { acquiredAt } : {}),
  };
  return withRecords(base, records);
}

/** The kept records without the credit `credit`: this device spent it, and
 *  its NFT is not known. The NFT read brings the NFT as a record of its own. */
export function onCreditSpent(kept: KeptCollectibles, credit: string): KeptCollectibles {
  const id = creditId(credit);
  if (kept.records[id]?.type !== 'credit') return kept;
  const { [id]: _spent, ...records } = kept.records;
  return withRecords(kept, records);
}

/** The kept records with the failed mint of credit `credit` on its record. Its
 *  time is never before this session's start, even when the device's clock was
 *  set back since. */
export function onMintFailed(
  kept: KeptCollectibles,
  credit: string,
  failure: FailureKind | undefined,
): KeptCollectibles {
  const id = creditId(credit);
  const r = kept.records[id];
  if (r?.type !== 'credit') return kept;
  const mintFailedAt = Math.max(Date.now(), SESSION_STARTED_AT);
  const failed = { ...withoutFailedMint(r), ...(failure ? { mintFailure: failure } : {}), mintFailedAt };
  return withRecords(kept, { ...kept.records, [id]: failed });
}

/** The kept records with the proof of `credit` dropped: the chain rejected it,
 *  so the next claim asks People for a fresh one. */
export function onProofRefused(kept: KeptCollectibles, credit: string): KeptCollectibles {
  const id = creditId(credit);
  const r = kept.records[id];
  if (r?.type !== 'credit' || !r.credit || (r.credit.proof === undefined && r.credit.leafIndex === undefined))
    return kept;
  const { leafIndex: _leaf, proof: _proof, ...withoutProof } = r.credit;
  return withRecords(kept, { ...kept.records, [id]: { ...r, credit: withoutProof } });
}

/** The kept records after reads of what credits would mint, each kept under
 *  its collection. The same item read again in one session writes nothing. */
export function onCollectionItemsRead(kept: KeptCollectibles, reads: readonly CollectionItemRead[]): KeptCollectibles {
  const records = { ...kept.records };
  for (const { credit, collectionId, ...read } of reads) {
    const id = creditId(credit);
    const r = records[id];
    if (r?.type !== 'credit') continue;
    const before = r.collectionItems?.[collectionId];
    const next = keepPicture(before, read);
    if (before && before.readAt >= SESSION_STARTED_AT && sameValue(before.item, next.item)) continue;
    records[id] = { ...r, collectionItems: { ...r.collectionItems, [collectionId]: next } };
  }
  return withRecords(kept, records);
}

/** `read`, with the item kept before in place of the same item read without
 *  its picture. */
function keepPicture(before: CollectionItem | undefined, read: CollectionItem): CollectionItem {
  const had = before?.item;
  const now = read.item;
  const lostPicture = had && now && had.hasArt !== false && now.hasArt === false;
  return lostPicture && had.collectionIndex === now.collectionIndex ? { ...read, item: had } : read;
}

/** What `record` would mint in the collection it goes to; undefined until it
 *  is read. */
export const selectedCollectionItemOf = (record: Collectible): CollectionItem | undefined =>
  record.selectedCollectionId === undefined ? undefined : record.collectionItems?.[record.selectedCollectionId];

/** The credit in the `OwnedNft` shape. */
function creditItem(c: Credit): OwnedNft {
  return {
    hash: c.hash,
    pending: true,
    ...(c.claimable ? { claimable: true } : {}),
    ...(c.awardedAt !== undefined ? { mintedAt: c.awardedAt } : {}),
    awardBlock: c.awardBlock,
  };
}

/** The record as an item: its NFT, or its credit. */
const itemOf = (r: Collectible): OwnedNft | null => r.nft ?? (r.credit ? creditItem(r.credit) : null);

/** Every record as an item, in order. */
export function itemsOf(kept: KeptCollectibles): OwnedNft[] {
  return kept.order.flatMap((id) => {
    const r = kept.records[id];
    const item = r ? itemOf(r) : null;
    return item ? [item] : [];
  });
}

const drawnEntries = new WeakMap<Collectible, CollectibleEntry>();

/** The record as the screen draws it. An NFT minted here that no read has given
 *  a name or a picture yet is drawn as the item its credit would mint. */
export function entryOf(r: Collectible): CollectibleEntry | null {
  const drawn = drawnEntries.get(r);
  if (drawn) return drawn;
  const item = itemOf(r);
  if (!item) return null;
  let entry = buildEntry(item);
  const wouldMint = r.nft && !r.nft.name && !r.nft.imageUrl ? selectedCollectionItemOf(r)?.item : undefined;
  if (wouldMint) entry = { ...entry, resolved: wouldMint };
  if (r.acquiredAt !== undefined) entry = { ...entry, acquiredAt: r.acquiredAt };
  if (r.nft && r.credit) entry = { ...entry, fromCredit: r.credit.hash };
  drawnEntries.set(r, entry);
  return entry;
}

/** Every record as the screen draws it, in order. */
export function entriesOf(kept: KeptCollectibles): CollectibleEntry[] {
  return kept.order.flatMap((id) => {
    const r = kept.records[id];
    const entry = r ? entryOf(r) : null;
    return entry ? [entry] : [];
  });
}

/** The record of credit `hash`, spent or not. */
export const recordOfCredit = (kept: KeptCollectibles, hash: string): Collectible | undefined =>
  kept.records[creditId(hash)];

export interface CollectiblesState extends KeptCollectibles {
  /** This session, not kept: the NFT read landed for this player. */
  nftsRead: boolean;
  /** This session, not kept: the credits are read, or there are none to read. */
  creditsKnown: boolean;
  /** This session, not kept: the stored selections were read, so each
   *  credit's collection is the one it mints into. */
  selectionsRead: boolean;
  /** This session, not kept: what the credits of the last read wait for. The
   *  block watches check it on every new block (features/holdings/sync.ts). */
  creditWatch: CreditWatch;
  readNfts: (owner: string, nfts: readonly OwnedNft[]) => void;
  /** `credits` null: there are no credits to read for this player (no credit
   *  account, or no People Chain); the credit records stay as kept. `selected`
   *  null: the stored selections could not be read; the collections stay as kept. */
  readCredits: (
    owner: string,
    credits: readonly Credit[] | null,
    selected: ReadonlyMap<string, SelectedCollection> | null,
  ) => void;
  minted: (owner: string, mint: Mint) => void;
  creditSpent: (credit: string) => void;
  proofRefused: (credit: string) => void;
  /** A credits read brought what its credits wait for. */
  setCreditWatch: (watch: CreditWatch) => void;
  /** A mint the app started by itself from `credit` failed. */
  mintFailed: (credit: string, failure: FailureKind | undefined) => void;
  /** What credits would mint was read (credits/collectionItems.ts). */
  readCollectionItems: (reads: readonly CollectionItemRead[]) => void;
  /** The player is known: records kept for another player are dropped. */
  setOwner: (owner: string) => void;
}

const KEY = 'pkt_collectibles_v1';
const VERSION = 2;

/** The kept part of a state, for comparing and for saving. */
const keptOf = (s: KeptCollectibles): KeptCollectibles => ({
  owner: s.owner,
  records: s.records,
  order: s.order,
});

/** The collectibles store over `storage`. The saved records are read by
 *  `persist.rehydrate()` (app/main.tsx). */
export function createCollectiblesStore(storage: StateStorage) {
  const store = createStore<CollectiblesState>()(
    persist(
      (set, get) => {
        /** Apply `next` to the kept part; a new owner starts this session over. */
        const apply = (
          next: KeptCollectibles,
          session: Partial<Pick<CollectiblesState, 'nftsRead' | 'creditsKnown' | 'selectionsRead'>>,
        ) => {
          const now = get();
          const newPlayer = !!now.owner && next.owner !== now.owner;
          const flags = {
            nftsRead: session.nftsRead ?? (newPlayer ? false : now.nftsRead),
            creditsKnown: session.creditsKnown ?? (newPlayer ? false : now.creditsKnown),
            selectionsRead: session.selectionsRead ?? (newPlayer ? false : now.selectionsRead),
          };
          const sameFlags =
            flags.nftsRead === now.nftsRead &&
            flags.creditsKnown === now.creditsKnown &&
            flags.selectionsRead === now.selectionsRead;
          if (sameKept(next, now) && sameFlags) return;
          set({ ...next, ...flags, ...(newPlayer ? { creditWatch: NOTHING_WATCHED } : {}) });
        };
        return {
          ...EMPTY_KEPT,
          nftsRead: false,
          creditsKnown: false,
          selectionsRead: false,
          creditWatch: NOTHING_WATCHED,
          readNfts: (owner, nfts) => apply(onNftsRead(keptOf(get()), owner, nfts), { nftsRead: true }),
          readCredits: (owner, credits, selected) =>
            apply(credits ? onCreditsRead(keptOf(get()), owner, credits, selected) : forOwner(keptOf(get()), owner), {
              creditsKnown: true,
              ...(credits && selected ? { selectionsRead: true } : {}),
            }),
          minted: (owner, mint) => apply(onMint(keptOf(get()), owner, mint), {}),
          creditSpent: (credit) => apply(onCreditSpent(keptOf(get()), credit), {}),
          proofRefused: (credit) => apply(onProofRefused(keptOf(get()), credit), {}),
          setCreditWatch: (watch) => set({ creditWatch: watch }),
          mintFailed: (credit, failure) => apply(onMintFailed(keptOf(get()), credit, failure), {}),
          readCollectionItems: (reads) => apply(onCollectionItemsRead(keptOf(get()), reads), {}),
          setOwner: (owner) => apply(forOwner(keptOf(get()), owner), {}),
        };
      },
      {
        name: KEY,
        version: VERSION,
        storage: createJSONStorage(() => storage),
        skipHydration: true,
        partialize: (s): KeptCollectibles => keptOf(s),
        // A kept store of another shape is dropped and read again from the chain.
        migrate: () => EMPTY_KEPT,
        merge: (kept, current) => ({ ...current, ...usableKept(kept) }),
      },
    ),
  );
  return store;
}

/** Whether two kept parts hold the same objects. */
function sameKept(a: KeptCollectibles, b: KeptCollectibles): boolean {
  return a.owner === b.owner && a.records === b.records && a.order === b.order;
}

/** The kept store as far as it is well formed: a record that is not drops out. */
export function usableKept(kept: unknown): KeptCollectibles {
  if (!kept || typeof kept !== 'object') return EMPTY_KEPT;
  const k = kept as Partial<Record<keyof KeptCollectibles, unknown>>;
  const keptRecords = k.records && typeof k.records === 'object' ? (k.records as Record<string, unknown>) : {};
  const records: Record<string, Collectible> = {};
  for (const [id, r] of Object.entries(keptRecords)) if (usableRecord(r, id)) records[id] = r;
  return {
    owner: typeof k.owner === 'string' ? k.owner : '',
    records,
    order: orderOf(records),
  };
}

function usableRecord(kept: unknown, id: string): kept is Collectible {
  if (!kept || typeof kept !== 'object') return false;
  const r = kept as Partial<Collectible>;
  if (r.id !== id || (r.type !== 'credit' && r.type !== 'nft')) return false;
  if (r.type === 'nft') return !!r.nft && typeof r.nft === 'object' && typeof r.nft.hash === 'string';
  return (
    !!r.credit &&
    typeof r.credit === 'object' &&
    typeof r.credit.hash === 'string' &&
    typeof r.credit.awardBlock === 'number'
  );
}

/** The app's holdings. */
export const collectiblesStore = createCollectiblesStore(stateStorage);

/** Read the holdings in a component: pick one field, so a change elsewhere in
 *  the store does not redraw it. */
export function useCollectibles<T>(pick: (state: CollectiblesState) => T): T {
  return useStore(collectiblesStore, pick);
}
