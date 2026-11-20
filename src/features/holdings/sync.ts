// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// Keeps the grid in step with the chain. Two parts are read on their own: the
// NFTs of the stash purse on Asset Hub (nfts/queries.ts), and the credits of
// Jollity's account on the People Chain. Each part reads again on a timer,
// when a watch sees its part of the chain change, and after a mint. A part
// that fails keeps what the grid shows, and the grid notes that it could not
// refresh. What each credit would mint is a read of its own, made when it was
// not read in this session.

import { ChainNotSupportedError, type NftPurseId, type NftPurseItemKey } from '@parity/product-sdk-host';
import type { Claimant } from '@parity/product-sdk-nfts';
import {
  QueriesObserver,
  QueryObserver,
  type QueryObserverOptions,
  type QueryObserverResult,
} from '@tanstack/query-core';
import type { PolkadotClient } from 'polkadot-api';

import type { FetchedManifest } from '@/entities/art/manifest';
import { collectionsStore } from '@/entities/collections/collectionsStore';
import { keepGasReadyForNextMint } from '@/entities/credits/claim';
import { fetchCollectionItems, hasUnreadItems, listPairsToPreview } from '@/entities/credits/collectionItems';
import { creditAccount, creditIdentityNow } from '@/entities/credits/creditAccount';
import { creditBlocksAt, creditStateAt, fetchClaims } from '@/entities/credits/credits';
import { fetchSelections, selectCollections, type Selection } from '@/entities/credits/selections';
import {
  type CollectiblesState,
  collectiblesStore,
  type CollectionItemRead,
  type Credit,
  type CreditWatch,
} from '@/entities/nfts/collectibles';
import { addArt, manifestCidsOf, type Manifests } from '@/entities/nfts/nfts';
import { accountPublicKeysQuery, artQuery, nftsQuery, queryClient, stashPurseQuery } from '@/entities/nfts/queries';
import { trackReads } from '@/entities/nfts/reads';
import type { StashPurseStatus } from '@/entities/nfts/stashPurse';
import type { OwnedNft } from '@/entities/nfts/types';
import { type BlockStream, type BlockWatch, watchBlocks } from '@/entities/nfts/watch';
import { recordsOwner, subscribePlayer } from '@/entities/player/identity';
import { type ChainApis, type ChainName, getChainApis, isChainLive, rebuildChain } from '@/shared/chain/client';
import { isLostBlock } from '@/shared/chain/lostBlock';
import { type ChainSyncError, setChainSyncStatus, setRefreshFailing } from '@/shared/chain/status';
import { isInContainer } from '@/shared/host/embed';
import { withDeadline } from '@/shared/lib/deadline';
import { subscribeOnline } from '@/shared/lib/online';
import { openStep } from '@/shared/telemetry/open';

/** A read of the credits, or of what they would mint, that takes longer is a
 *  dead connection, and counts as failed. */
const READ_DEADLINE_MS = 30_000;
/** The credits are read again this long after the last read, in case a watch missed a change. */
const CREDITS_READ_INTERVAL_MS = 30_000;
/** What the credits would mint is read again this long after the last read
 *  ended, for those whose read failed or whose picture was not served. */
const PREVIEW_RETRY_MS = 15_000;
/** The most often a watch checks its chain: about once a block. */
const WATCH_INTERVAL_MS = 5_000;
/** A chain that stopped making blocks gets a new client at most this often. */
const REBUILD_GAP_MS = 60_000;

const NO_NFTS: OwnedNft[] = [];

/** One part of what the grid shows, read on its own. */
interface Part {
  /** Read now. A read already running is dropped for the new one. */
  refresh(): void;
  /** Start over for this player. */
  startOver(player: string | null): void;
}

/** A credits read, with the connection and the account it was made for. */
interface CreditsRead {
  apis: ChainApis;
  who: Claimant;
  /** Whose records the read writes. */
  owner: string;
  credits: Credit[];
  /** The selections stored on this device, null when they could not be read. */
  selections: Map<string, Selection> | null;
  watch: CreditWatch;
  peopleSignature?: string;
}

/** One watch on one client: replaced when the client is. */
interface Armed {
  raw: PolkadotClient;
  watch: BlockWatch;
}

let running = false;
let refreshAll: (() => void) | null = null;
let refreshCredits: () => void = () => {};
const failing = { nfts: false, credits: false };
const rebuiltAt: Record<ChainName, number> = { assetHub: 0, people: 0 };
/** The time of the failure last reported: a failure with the same time is not
 *  reported again. */
let reportedAt = 0;

let nfts: OwnedNft[] | null = null;
let manifests: Manifests = {};

let creditAsked = false;
let creditStateWatch: Armed | null = null;
let peopleWatch: (Armed & { who: string }) | null = null;

/** Starts the sync once per page. Outside a host there is no player and no
 *  connection, so the sync stays off. */
export function startChainSync(): void {
  if (running || !isInContainer) return;
  running = true;
  queryClient.mount();
  trackReads(queryClient.getQueryCache());
  const nftReads = startNftReads();
  const creditReads = startCreditReads();
  refreshAll = () => {
    nftReads.refresh();
    creditReads.refresh();
  };
  readAgainWhenOnline(nftReads, creditReads);
  followPlayer(nftReads, creditReads);
  startCollectionItemReads();
  // A credit's default collection depends on which collections are offered.
  collectionsStore.subscribe((now, before) => {
    if (now.known !== before.known || now.favourites !== before.favourites) creditReads.refresh();
  });
}

/** Reads both parts now, so a mint shows without waiting for a watch or the
 *  timer. Does nothing while the sync is off. */
export function refreshChainSync(): void {
  refreshAll?.();
}

/** The NFTs: the stash purse, the accounts in it that hold an NFT, the NFTs
 *  of those accounts, and their art, each a query that passes its result on. */
function startNftReads(): Part {
  const artObserver = new QueriesObserver(queryClient, []);
  const nftsObserver = new QueryObserver<OwnedNft[]>(queryClient, { ...nftsQuery([]), enabled: false });
  const purseObserver = new QueryObserver<StashPurseStatus>(queryClient, { ...stashPurseQuery, enabled: false });
  let accountsObserver: QueryObserver<NftPurseItemKey[]> | null = null;
  let listedKeys: NftPurseItemKey[] | null = null;

  function listAccounts(purseId: NftPurseId): void {
    if (accountsObserver) return;
    accountsObserver = new QueryObserver<NftPurseItemKey[]>(queryClient, accountPublicKeysQuery(purseId));
    accountsObserver.subscribe((result) => {
      if (result.isError) {
        // The Polkadot app is slow and the chains are fine: no connection error.
        reportOnce(result.errorUpdatedAt, () => {
          console.warn('[chain] waiting on the Polkadot app:', result.error);
          setChainSyncStatus('waiting');
        });
        return;
      }
      if (!result.data) return;
      if (nfts && !failing.nfts) setChainSyncStatus('ok');
      if (result.data === listedKeys) return;
      listedKeys = result.data;
      nftsObserver.setOptions({ ...nftsQuery(result.data), enabled: true });
    });
  }

  artObserver.subscribe(takeArt);
  nftsObserver.subscribe((result) => {
    if (result.isError) reportOnce(result.errorUpdatedAt, () => failNfts(result.error));
    // While the NFTs of a new list load, the query still returns the old list's.
    else if (result.isSuccess && !result.isPlaceholderData) takeNfts(result.data, artObserver);
  });
  purseObserver.subscribe((result) => {
    if (!result.data) {
      if (result.failureCount > 0) setChainSyncStatus('waiting');
    } else if (result.data.status === 'ready') {
      listAccounts(result.data.id);
    } else {
      // A host without purses holds no NFT of this app: the grid opens on the credits alone.
      takeNfts(NO_NFTS, artObserver);
    }
  });

  return {
    refresh: () => {
      void accountsObserver?.refetch();
      if (listedKeys) void nftsObserver.refetch();
    },
    startOver: (player) => {
      if (player) purseObserver.setOptions({ ...stashPurseQuery, enabled: true });
    },
  };
}

function takeNfts(read: OwnedNft[], artObserver: QueriesObserver): void {
  setFailing('nfts', false);
  setChainSyncStatus('ok');
  if (read === nfts) return;
  nfts = read;
  openStep('NFTs read', { count: read.length });
  // The list takes queries of any result type, so each one's own type is given up here.
  artObserver.setQueries(manifestCidsOf(read).map(artQuery) as QueryObserverOptions[]);
  showNfts();
}

function takeArt(results: QueryObserverResult[]): void {
  const cids = manifestCidsOf(nfts ?? []);
  const arrived: Manifests = {};
  results.forEach((result, i) => {
    const cid = cids[i];
    if (cid && result.data) arrived[cid] = result.data as FetchedManifest;
  });
  if (hasSameManifests(arrived, manifests)) return;
  manifests = arrived;
  showNfts();
}

function hasSameManifests(a: Manifests, b: Manifests): boolean {
  const cids = Object.keys(a);
  return cids.length === Object.keys(b).length && cids.every((cid) => a[cid] === b[cid]);
}

function showNfts(): void {
  if (nfts) collectiblesStore.getState().readNfts(recordsOwner(), addArt(nfts, manifests));
}

function failNfts(error: unknown): void {
  setFailing('nfts', true);
  console.warn('[chain] NFTs unavailable', error);
  setChainSyncStatus('error', { message: describeSyncError(error) });
  rebuildIfStopped('assetHub');
}

/** The credits of Jollity's account, one query per player. */
function startCreditReads(): Part {
  const observer = new QueryObserver<CreditsRead | null>(queryClient, { ...creditsQuery(''), enabled: false });
  let takenAt = 0;
  let reportedFailure: unknown = null;
  observer.subscribe((result) => {
    if (result.failureReason && result.failureReason !== reportedFailure) {
      reportedFailure = result.failureReason;
      failCredits(result.failureReason, result.failureCount);
    }
    if (result.isSuccess && result.dataUpdatedAt !== takenAt) {
      takenAt = result.dataUpdatedAt;
      takeCredits(result.data);
    }
  });
  // A read still running is dropped first: the query reuses it while it has no data yet.
  refreshCredits = () => void queryClient.cancelQueries({ queryKey: ['credits'] }).then(() => observer.refetch());
  return {
    refresh: refreshCredits,
    startOver: (player) => {
      forgetCredits();
      observer.setOptions({ ...creditsQuery(player ?? ''), enabled: true });
    },
  };
}

function creditsQuery(player: string) {
  return {
    queryKey: ['credits', player],
    queryFn: () => withDeadline(fetchCredits(), READ_DEADLINE_MS, 'the credits read'),
    refetchInterval: CREDITS_READ_INTERVAL_MS,
    retry: 3,
    // Each read carries its connection, which is nothing to compare.
    structuralSharing: false,
  } satisfies QueryObserverOptions<CreditsRead | null>;
}

/** Reads the credits of Jollity's account, and with them the collections
 *  selected for them. Null while the host has not named that account, or when
 *  it serves no People Chain. */
async function fetchCredits(): Promise<CreditsRead | null> {
  const who = creditIdentityNow();
  if (!who) {
    askCreditAccount();
    return null;
  }
  const apis = await getChainApis();
  if (!apis) throw new Error('no chain connection this session');
  if (!apis.people) return null;
  const [claims, selections] = await Promise.all([fetchClaims(apis, who), fetchSelections()]);
  return { apis, who, owner: recordsOwner(), ...claims, selections };
}

/** Asks the host for Jollity's account, one ask at a time, and reads the
 *  credits the moment it names one. */
function askCreditAccount(): void {
  if (creditAsked) return;
  creditAsked = true;
  void creditAccount().then((found) => {
    creditAsked = false;
    if (found) refreshCredits();
  });
}

function takeCredits(read: CreditsRead | null): void {
  setFailing('credits', false);
  const store = collectiblesStore.getState();
  if (!read) {
    if (!store.creditsKnown) store.readCredits(recordsOwner(), null, null);
    return;
  }
  openStep('credits read', { count: read.credits.length });
  // Compared with the records as they are before this read lands.
  const moreToMint = bringsMoreToMint(read, store);
  const selected = read.selections && selectCollections(read.credits, read.selections);
  store.readCredits(read.owner, read.credits, selected);
  store.setCreditWatch(read.watch);
  // Jollity's account gets the gas of the new credits ahead of their mint.
  if (moreToMint && read.who.tag === 'Account') keepGasReadyForNextMint(read.apis, read.who.address);
  armCreditWatches(read.apis, read.who);
  peopleWatch?.watch.rebase(read.peopleSignature);
  // Everything the read made the credit watch wait for was still to happen.
  creditStateWatch?.watch.rebase('');
}

const isReadyToMint = (credit: Credit | undefined): boolean => !!credit?.claimable && !!credit.proof;

/** Whether `read` brings more claimable credits with a proof than `held` has, or is the
 *  first credits read of the session and brings any. */
function bringsMoreToMint(read: CreditsRead, held: CollectiblesState): boolean {
  const ready = read.credits.filter(isReadyToMint).length;
  const readyHeld = Object.values(held.records).filter((r) => r.type === 'credit' && isReadyToMint(r.credit)).length;
  return ready > readyHeld || (!held.creditsKnown && ready > 0);
}

/** A failed credits read leaves the credits as they were. The first try that
 *  only lost its block is no failure yet: the query tries again a second later. */
function failCredits(error: unknown, tries: number): void {
  if (tries === 1 && isLostBlock(error)) return;
  setFailing('credits', true);
  const detail = error instanceof Error ? error.message : String(error);
  console.warn('[chain] credits unavailable, the grid keeps them as they were:', detail);
  rebuildIfStopped('people');
}

/** Another player: the credits start over, and their watches stop. */
function forgetCredits(): void {
  setFailing('credits', false);
  for (const armed of [creditStateWatch, peopleWatch]) armed?.watch.stop();
  creditStateWatch = null;
  peopleWatch = null;
}

/** Watches the blocks each client already streams for what the credits wait
 *  for, and reads again the moment it changes. */
function armCreditWatches(apis: ChainApis, who: Claimant): void {
  const assetHubRaw = apis.raw.assetHub;
  if (creditStateWatch?.raw !== assetHubRaw) {
    creditStateWatch?.watch.stop();
    const assetHub = apis.assetHub;
    creditStateWatch = {
      raw: assetHubRaw,
      watch: watchBlocks({
        blocks: streamNewestBlocks(assetHubRaw),
        check: (hash) => creditStateAt(assetHub, collectiblesStore.getState().creditWatch, hash),
        // A claim spends the leaf and mints into a purse in the same block.
        onChange: () => refreshAll?.(),
        minIntervalMs: WATCH_INTERVAL_MS,
      }),
    };
  }
  const peopleRaw = apis.raw.people;
  const people = apis.people;
  if (!peopleRaw || !people) return;
  if (peopleWatch?.raw === peopleRaw && peopleWatch.who === claimantKey(who)) return;
  peopleWatch?.watch.stop();
  peopleWatch = {
    raw: peopleRaw,
    who: claimantKey(who),
    // The claims read takes People at the newest block, so this does too.
    watch: watchBlocks({
      blocks: streamNewestBlocks(peopleRaw),
      check: (hash) => creditBlocksAt(people, who, collectiblesStore.getState().creditWatch.rootless, hash),
      onChange: () => refreshCredits(),
      minIntervalMs: WATCH_INTERVAL_MS,
    }),
  };
}

/** Reads what each credit would mint in the collection it goes to: at once
 *  for a credit whose item was not read in this session, and again
 *  PREVIEW_RETRY_MS after each read for whatever is still to read. */
function startCollectionItemReads(): void {
  const observer = new QueryObserver<CollectionItemRead[]>(queryClient, collectionItemsQuery);
  // A read already running is left to end. This runs again after it, for a credit that came meanwhile.
  const readUnreadItems = (): void => {
    if (hasUnreadItems(collectiblesStore.getState().records)) void observer.refetch({ cancelRefetch: false });
  };
  let taken: CollectionItemRead[] | undefined;
  observer.subscribe((result) => {
    if (result.isError) {
      reportOnce(result.errorUpdatedAt, () => console.warn('[chain] what the credits would mint:', result.error));
    }
    if (!result.isSuccess || result.data === taken) return;
    taken = result.data;
    collectiblesStore.getState().readCollectionItems(result.data);
    readUnreadItems();
  });
  collectiblesStore.subscribe((now, before) => {
    if (now.records !== before.records) readUnreadItems();
  });
}

/** Reads every item that is to be read now; with none, it makes no call. */
const collectionItemsQuery = {
  queryKey: ['collectionItems'],
  queryFn: () =>
    withDeadline(
      fetchCollectionItems(listPairsToPreview(collectiblesStore.getState().records)),
      READ_DEADLINE_MS,
      'the read of what the credits would mint',
    ),
  refetchInterval: PREVIEW_RETRY_MS,
  // The interval above is the next try.
  retry: false,
  // Each read carries its time, which is nothing to compare.
  structuralSharing: false,
} satisfies QueryObserverOptions<CollectionItemRead[]>;

/** Follows the player for the life of the page: the same player again reads
 *  both parts, and another player starts both over, without the records kept
 *  for the one before. */
function followPlayer(nftReads: Part, creditReads: Part): void {
  let player: string | null | undefined;
  subscribePlayer((next) => {
    const same = next === player;
    player = next;
    if (same) {
      refreshAll?.();
      return;
    }
    collectiblesStore.getState().setOwner(recordsOwner());
    nftReads.startOver(next);
    creditReads.startOver(next);
  });
}

/** The network back: both parts read again at once, past any read still hanging. */
function readAgainWhenOnline(nftReads: Part, creditReads: Part): void {
  let offline = false;
  subscribeOnline((online) => {
    if (!online) {
      offline = true;
      return;
    }
    if (!offline) return;
    offline = false;
    nftReads.refresh();
    creditReads.refresh();
  });
}

function setFailing(part: keyof typeof failing, value: boolean): void {
  failing[part] = value;
  setRefreshFailing(failing.nfts || failing.credits);
}

function reportOnce(at: number, report: () => void): void {
  if (at === reportedAt) return;
  reportedAt = at;
  report();
}

/** Replaces `chain`'s client after a failed read, only when that chain has
 *  stopped making blocks: a healthy connection never gives up its place. */
function rebuildIfStopped(chain: ChainName): void {
  const now = Date.now();
  if (isChainLive(chain, now) || now - rebuiltAt[chain] < REBUILD_GAP_MS) return;
  rebuiltAt[chain] = now;
  console.warn(`[chain] ${chain} has stopped making blocks; replacing its connection`);
  rebuildChain(chain).catch((err: unknown) => {
    console.warn(`[chain] replacing the ${chain} connection failed`, err);
  });
}

/** A claimant as one text, so two can be compared. */
const claimantKey = (who: Claimant): string => (who.tag === 'Account' ? `a:${who.address}` : `p:${who.alias}`);

/** The one line the empty grid shows for a failed NFT read. */
function describeSyncError(err: unknown): ChainSyncError['message'] {
  if (isUnsupportedNetwork(err)) return 'This version of the Polkadot app isn’t supported.';
  const msg = err instanceof Error ? err.message : String(err);
  if (/timed out/i.test(msg)) return 'This is taking longer than usual. Still trying.';
  if (/no chain connection/i.test(msg)) return 'Can’t connect right now. Still trying.';
  return 'Something went wrong. Still trying.';
}

/** Whether the host runs another network than the one this build was made for. */
function isUnsupportedNetwork(err: unknown): boolean {
  if (err instanceof ChainNotSupportedError) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /not supported by the current host/i.test(msg);
}

/** The newest blocks of a client: what the grid shows is read at the newest block (readAt.ts). */
function streamNewestBlocks(raw: PolkadotClient): BlockStream {
  return {
    subscribe: (observer) =>
      raw.bestBlocks$.subscribe({
        next: ([newest]) => {
          if (newest) observer.next({ hash: newest.hash, number: newest.number });
        },
        error: (err: unknown) => observer.error?.(err),
      }),
  };
}
