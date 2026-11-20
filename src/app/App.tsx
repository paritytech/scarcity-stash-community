// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// The app: what the player holds, kept current and drawn on the grid, or the
// screen that shows why the grid is not there yet. Each step is one function
// below.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import {
  catalogueReady,
  currentCatalogues,
  ensureCatalogues,
  staleCatalogues,
  subscribeCatalogues,
} from '@/entities/collections/catalogueStore';
import {
  getCollection,
  getRegistrySnapshot,
  isFirstReadRunning,
  kickRegistry,
  offeredCollectionIds,
  startRegistry,
  subscribeRegistryState,
} from '@/entities/collections/registry';
import {
  creditId,
  entriesOf,
  itemsOf,
  type KeptCollectibles,
  selectedCollectionItemOf,
  useCollectibles,
} from '@/entities/nfts/collectibles';
import type { CollectibleEntry } from '@/entities/nfts/format';
import type { OwnedNft } from '@/entities/nfts/types';
import { recordsOwner, subscribePlayer } from '@/entities/player/identity';
import { setGridField } from '@/features/grid/engine';
import GridScreen from '@/features/grid/GridScreen';
import {
  buildFieldLayout,
  type FieldCollection,
  type FieldLayout,
  nextAgeOut,
  overlayField,
  type PieceState,
} from '@/features/grid/model/field';
import {
  type ChainSyncError,
  type ChainSyncStatus,
  subscribeChainSyncError,
  subscribeChainSyncStatus,
  subscribeRefreshFailing,
} from '@/shared/chain/status';
import { openedBefore, readSeen } from '@/shared/lib/deviceStore';
import { normalizeHash } from '@/shared/lib/hash';
import type { OpenTarget } from '@/shared/lib/location';
import { onlineNow, subscribeOnline } from '@/shared/lib/online';
import { nowSeconds, wakeAt } from '@/shared/lib/wake';
import { openStep } from '@/shared/telemetry/open';

/** How long the app waits for the NFTs, or for the catalogues, before it shows
 *  why; records kept on the device draw at once. */
const BOOT_TIMEOUT_MS = 8_000;

/** How long the grid waits for the catalogues before it opens without the
 *  ones still loading (their regions fill in when they land). */
const CATALOGUE_WAIT_MS = 2_500;

type Screen = 'opening' | 'profile late' | 'unreachable' | 'grid';

export default function App() {
  const records = useCollectibles((s) => s.records);
  const order = useCollectibles((s) => s.order);
  // The NFTs are read this session for the player shown.
  const delivered = useCollectibles((s) => s.nftsRead);
  const registryReads = useRegistryReads();
  const namesLoading = useSyncExternalStore(subscribeRegistryState, isFirstReadRunning);
  const health = useChainHealth();
  const owner = useRecordsOwner();
  const offline = !useSyncExternalStore(subscribeOnline, onlineNow);

  const kept = useMemo<KeptCollectibles>(() => ({ owner: '', records, order }), [records, order]);
  const items = useMemo(() => itemsOf(kept), [kept]);
  const entries = useMemo(() => entriesOf(kept), [kept]);
  const entriesRef = useLatest(entries);
  const gridEntries = useMemo(() => placeCredits(entries, records), [entries, records]);
  const gridCollections = useMemo(
    () => gridCollectionsOf(entries, namesLoading),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- registryReads versions the registry module this reads
    [entries, namesLoading, registryReads],
  );
  const newness = useNewness(delivered, items, gridEntries);

  useOpenSteps(delivered, entries.length);

  const catalogues = useCatalogues(gridCollections, entries, registryReads);
  const layout = useMemo(
    () => buildFieldLayout(gridCollections, catalogues.slots, gridEntries),
    [gridCollections, catalogues.slots, gridEntries],
  );
  const pieces = useMemo(
    () => overlayField(layout, gridEntries, newness.unseen, newness.newAt),
    [layout, gridEntries, newness.unseen, newness.newAt],
  );
  // The holdings drawn last time open at once, before the chain read has returned:
  // offline, they are what the player sees.
  const drawnBefore = !delivered && entries.length > 0;
  // With nothing to lay out the grid waits for every catalogue, or opens empty once a read is failing.
  const cataloguesSettled = catalogues.allIn || catalogues.failing || (catalogues.waitOver && layout.cells.length > 0);
  const ready = (drawnBefore || (delivered && newness.known)) && cataloguesSettled;
  useGridField({ layout, pieces, ready, drawnBefore, records, firstRecord: newness.firstRecord });

  const gridHooks = useGridHooks(entriesRef);
  const bootTimedOut = useBootTimeout(delivered);
  const screen = screenOf({ delivered, bootTimedOut, owner, syncStatus: health.syncStatus, drawn: entries.length });
  const readsFailing = health.refreshFailed || (drawnBefore && bootTimedOut) || catalogues.failing;

  return (
    <div className="page">
      {screen === 'grid' ? (
        <GridScreen hooks={gridHooks} readsFailing={readsFailing} offline={offline} />
      ) : (
        <StatusScreen screen={screen} offline={offline} error={health.syncError} />
      )}
    </div>
  );
}

/** A ref that always holds the latest `value`, for callbacks that stay the
 *  same between renders. */
function useLatest<T>(value: T): { readonly current: T } {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}

/** Reads the collection registry until it lands, and returns how many reads
 *  landed, so the names drawn from it are read again. */
function useRegistryReads(): number {
  const [reads, setReads] = useState(0);
  useEffect(() => {
    startRegistry();
    let seen = 0;
    const stopReads = subscribeRegistryState((s) => {
      if (s.reads === seen) return;
      seen = s.reads;
      setReads((n) => n + 1);
    });
    const stopStatus = subscribeChainSyncStatus((status) => {
      if (status === 'ok' && getRegistrySnapshot().length === 0) kickRegistry();
    });
    return () => {
      stopReads();
      stopStatus();
    };
  }, []);
  return reads;
}

/** How the chain sync stands, so an empty grid caused by a connection failure
 *  reads as one, and whether the last read failed. */
function useChainHealth() {
  const [syncStatus, setSyncStatus] = useState<ChainSyncStatus>('idle');
  const [syncError, setSyncError] = useState<ChainSyncError | null>(null);
  const [refreshFailed, setRefreshFailed] = useState(false);
  useEffect(() => subscribeChainSyncStatus(setSyncStatus), []);
  useEffect(() => subscribeChainSyncError(setSyncError), []);
  useEffect(() => subscribeRefreshFailing(setRefreshFailed), []);
  return { syncStatus, syncError, refreshFailed };
}

/** Whose records the store holds, once the player is known; '' until then. */
function useRecordsOwner(): string {
  const [owner, setOwner] = useState(recordsOwner);
  useEffect(() => subscribePlayer(() => setOwner(recordsOwner())), []);
  return owner;
}

/** Where the grid places each entry: an NFT as it is, a credit as the item it
 *  would mint in the collection it goes to. A credit whose item is not read
 *  yet, or that would mint nothing there, stands nowhere. */
function placeCredits(entries: CollectibleEntry[], records: KeptCollectibles['records']): CollectibleEntry[] {
  return entries.flatMap((entry) => {
    if (!entry.pending) return [entry];
    const record = records[creditId(entry.hash)];
    const item = record && selectedCollectionItemOf(record)?.item;
    if (!record?.selectedCollectionId || !item) return [];
    return [
      {
        ...entry,
        collectionId: record.selectedCollectionId,
        itemIndex: item.collectionIndex - 1,
        resolved: item,
      },
    ];
  });
}

/** The collections on the grid: the offered ones in their order, then any other the player holds a
 *  piece from, by id. While `namesLoading`, one the device kept no name for has its name still on the way. */
function gridCollectionsOf(entries: CollectibleEntry[], namesLoading: boolean): FieldCollection[] {
  const ids = offeredCollectionIds();
  const held = new Set<string>();
  for (const e of entries) if (!e.pending && e.collectionId) held.add(e.collectionId);
  for (const id of [...held].sort((a, b) => Number(a) - Number(b))) if (!ids.includes(id)) ids.push(id);
  const named = new Set(getRegistrySnapshot().map((c) => c.id));
  return ids.map((id) => ({
    id,
    name: getCollection(id).label,
    ...(namesLoading && !named.has(id) ? { nameLoading: true } : {}),
  }));
}

/** What New holds: the pieces this device hasn't seen, taken once the first
 *  delivery lands, judged again each time a piece in it turns 12 hours old. */
function useNewness(delivered: boolean, items: OwnedNft[], gridEntries: CollectibleEntry[]) {
  const [firstSight, setFirstSight] = useState<FirstSight | null>(null);
  const [newAt, setNewAt] = useState(nowSeconds);
  // Taken in the render the first delivery lands in, so no field goes to the grid without it.
  if (delivered && !firstSight) {
    const seen = readSeen();
    const hashes = items.filter((i) => !i.pending).map((i) => normalizeHash(i.hash));
    setFirstSight({ unseen: new Set(hashes.filter((h) => !seen.has(h))), firstRecord: !openedBefore() });
  }
  useEffect(() => wakeAt(nextAgeOut(gridEntries, newAt), () => setNewAt(nowSeconds())), [gridEntries, newAt]);
  return { ...(firstSight ?? NOTHING_SEEN_YET), newAt, known: firstSight !== null };
}

/** What the first delivery found: the pieces this device had not seen, and
 *  whether it had no record of seen pieces before this open. */
interface FirstSight {
  unseen: Set<string>;
  firstRecord: boolean;
}
const NOTHING_SEEN_YET: FirstSight = { unseen: new Set(), firstRecord: false };

/** The open journey's steps: ready on the first frame, and the grid drawn a
 *  frame after the first delivery with pieces. */
function useOpenSteps(delivered: boolean, count: number): void {
  useEffect(() => openStep('ready'), []);
  useEffect(() => {
    if (!delivered || count === 0) return;
    const id = requestAnimationFrame(() => openStep('grid drawn', { count }));
    return () => cancelAnimationFrame(id);
  }, [delivered, count]);
}

/** Each collection's size as the registry knows it: one too large to read
 *  whole is skipped every time it is asked for, not only the first. */
function sizesOf(ids: readonly string[]): Record<string, number | undefined> {
  const sizes: Record<string, number | undefined> = {};
  for (const id of ids) sizes[id] = getCollection(id).itemCount;
  return sizes;
}

const idsOf = (joined: string): string[] => (joined ? joined.split(',') : []);

/** The catalogues of the grid's collections, read during render so the first
 *  frame has the kept ones. `failing`: a read failed, or is not in after BOOT_TIMEOUT_MS. */
function useCatalogues(collections: FieldCollection[], entries: CollectibleEntry[], registryReads: number) {
  const slots = useSyncExternalStore(subscribeCatalogues, currentCatalogues);
  const [waitOver, setWaitOver] = useState(false);
  const joined = collections.map((c) => c.id).join(',');
  useEffect(() => {
    const ids = idsOf(joined);
    const count = (id: string): number => entries.filter((e) => !e.pending && e.collectionId === id).length;
    ensureCatalogues(
      [...ids].sort((a, b) => count(b) - count(a)),
      sizesOf(ids),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read again when the set of collections changes, not on every poll
  }, [joined, registryReads]);
  useEffect(() => {
    const onVisible = (): void => {
      if (document.visibilityState !== 'visible') return;
      staleCatalogues();
      ensureCatalogues(idsOf(joined), sizesOf(idsOf(joined)));
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [joined]);
  useEffect(() => {
    const t = window.setTimeout(() => setWaitOver(true), CATALOGUE_WAIT_MS);
    return () => window.clearTimeout(t);
  }, []);
  const allIn = collections.every((c) => catalogueReady(slots[c.id]));
  const late = useBootTimeout(allIn);
  const failed = collections.some((c) => slots[c.id]?.status === 'failed');
  return { slots, allIn, waitOver, failing: failed || late };
}

interface FieldHandoff {
  layout: FieldLayout;
  pieces: PieceState[];
  ready: boolean;
  drawnBefore: boolean;
  records: KeptCollectibles['records'];
  firstRecord: boolean;
}

/** Passes each new field to the engine. An NFT whose record is new since the
 *  field before arrives with an orb. */
function useGridField({ layout, pieces, ready, drawnBefore, records, firstRecord }: FieldHandoff): void {
  const idsBeforeRef = useRef<Set<string> | null>(null);
  useLayoutEffect(() => {
    if (!ready) {
      setGridField({ layout, pieces, ready: false });
      return;
    }
    const idsBefore = idsBeforeRef.current;
    const arrived = idsBefore ? listNewNfts(records, idsBefore) : [];
    idsBeforeRef.current = new Set(Object.keys(records));
    setGridField(
      { layout, pieces, ready: true, firstRecord, kept: drawnBefore },
      arrived.length ? [{ hashes: arrived }] : [],
    );
  }, [layout, pieces, ready, drawnBefore, records, firstRecord]);
}

/** Returns the hashes of the NFTs whose record id is not in `idsBefore`. An NFT
 *  minted from a credit keeps the credit's record, so it is not new. */
function listNewNfts(records: KeptCollectibles['records'], idsBefore: ReadonlySet<string>): string[] {
  return Object.values(records).flatMap((record) =>
    record.nft && !idsBefore.has(record.id) ? [normalizeHash(record.nft.hash)] : [],
  );
}

/** What the grid asks of the app, the same between chain reads so the grid
 *  never re-renders for one. */
function useGridHooks(entriesRef: { readonly current: CollectibleEntry[] }) {
  return useMemo(
    () => ({
      // How long the saved holdings took to show, from the page's start, and
      // the screen a link opened the app on.
      opened: (kept: boolean, target: OpenTarget['open'] | null) => {
        if (kept) openStep('saved shown', { count: entriesRef.current.length, ms: Math.round(performance.now()) });
        if (target) openStep('opened to', { target });
      },
    }),
    [entriesRef],
  );
}

/** Whether the app has waited BOOT_TIMEOUT_MS for `arrived`. The wait starts
 *  over each time `arrived` turns false. */
function useBootTimeout(arrived: boolean): boolean {
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    if (arrived) return;
    const t = window.setTimeout(() => setTimedOut(true), BOOT_TIMEOUT_MS);
    return () => {
      window.clearTimeout(t);
      setTimedOut(false);
    };
  }, [arrived]);
  return timedOut;
}

interface ScreenFacts {
  delivered: boolean;
  bootTimedOut: boolean;
  owner: string;
  syncStatus: ChainSyncStatus;
  /** How many entries the grid would draw. */
  drawn: number;
}

/** Which screen shows. Connection trouble replaces only an empty grid; one with
 *  pieces keeps showing them while the sync retries. */
function screenOf({ delivered, bootTimedOut, owner, syncStatus, drawn }: ScreenFacts): Screen {
  const waitingOnApp = owner === '' || syncStatus === 'waiting';
  if (!delivered && drawn === 0 && (!bootTimedOut || waitingOnApp)) return bootTimedOut ? 'profile late' : 'opening';
  if (drawn === 0 && syncStatus === 'error') return 'unreachable';
  return 'grid';
}

/** What a browser tab shows: the app reads and mints only inside a host. */
export function HostNotice() {
  return (
    <div className="page">
      <div className="state-screen">
        <p className="state-title">Open Collectibles in the Polkadot app</p>
        <p className="state-copy">Your collection lives in the app, with your games.</p>
      </div>
    </div>
  );
}

function StatusScreen({ screen, offline, error }: { screen: Screen; offline: boolean; error: ChainSyncError | null }) {
  if (screen === 'unreachable')
    return (
      <div className="state-screen" role="alert">
        <p className="state-title">Can&rsquo;t reach your collection</p>
        {offline ? (
          <p className="state-copy">Offline.</p>
        ) : (
          <>
            {error && <p className="state-copy">{error.message}</p>}
            <div className="state-busy">
              <span className="ui-spin" />
              Reconnecting
            </div>
          </>
        )}
      </div>
    );
  return (
    <div className="state-screen" aria-live="polite">
      <div className="state-busy">
        <span className="ui-spin" />
        {screen === 'profile late' ? 'Couldn’t load your profile yet. Trying again.' : 'Opening your collection'}
      </div>
    </div>
  );
}
