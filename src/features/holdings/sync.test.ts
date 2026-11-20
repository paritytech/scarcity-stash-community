// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// The sync drives the grid from two parts, each read on its own: the NFTs of
// the stash purse and the credits, and reads what each credit would mint.
// These tests run the real sync, queries,
// store and status over a fake Asset Hub, a host that lists the purse's
// accounts, and a stand-in for the credits read, with block streams the test
// pushes by hand. They show the rules of the sync: a read that hangs holds
// up only its own part, a new list of accounts is read at once, the credits
// follow their watches and a backup poll, and the note that the grid could not
// refresh follows the last read of each part.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StashPurseStatus } from '@/entities/nfts/stashPurse';
import { fakeAssetHub, fakePeople, fakeRawClient, nft } from '@/testing/fakeChain';
import { alice, ALICE_42 } from '@/testing/fixtures';

const h = vi.hoisted(() => ({
  getChainApis: vi.fn(),
  rebuildChain: vi.fn(async (_chain: string) => {}),
  live: true,
  fetchClaims: vi.fn(),
  fetchSelections: vi.fn(),
  selectCollections: vi.fn(),
  /** What each (credit, collection) pair would mint, as the chain call returns it. */
  previews: vi.fn(),
  creditBlocksAt: vi.fn(),
  creditStateAt: vi.fn(),
  keepGasReady: vi.fn(),
  /** The accounts of the stash purse that hold an NFT, as the host lists them. */
  accounts: (): string[] => [],
  /** The stash purse, as the host returns it from the lookup. */
  purse: null as StashPurseStatus | null,
  /** The player the host names, and who follows it. */
  player: null as string | null,
  playerListeners: new Set<(player: unknown) => void>(),
  /** The device's network, as lib/online.ts would report it. */
  online: { now: true, listeners: new Set<(online: boolean) => void>() },
}));

vi.mock('@parity/product-sdk-host', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getNftPurseManager: async () => ({ createItems: async () => ['addr-new'] }),
}));
vi.mock('@/entities/nfts/stashPurse', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  lookUpStashPurse: async () => h.purse,
  listAccountPublicKeys: async () => h.accounts(),
}));
// The fake Asset Hub keys its accounts by plain names, so a public key is its own address here.
vi.mock('@/shared/chain/ss58', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  addressOfPublicKey: (publicKey: string) => publicKey,
}));
vi.mock('@/shared/host/embed', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isInContainer: true,
}));
vi.mock('@/shared/chain/client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getChainApis: (...args: unknown[]) => h.getChainApis(...args),
  isChainLive: () => h.live,
  rebuildChain: (chain: string) => h.rebuildChain(chain),
}));
vi.mock('@/entities/player/identity', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getPlayerAddress: () => h.player,
  recordsOwner: () => (h.player ? `a:${h.player}|` : ''),
  subscribePlayer: (cb: (player: unknown) => void) => {
    h.playerListeners.add(cb);
    cb(h.player);
    return () => h.playerListeners.delete(cb);
  },
}));
vi.mock('@/entities/credits/creditAccount', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  creditIdentityNow: () => alice,
  creditIdentity: async () => alice,
  creditSigner: async () => ({}),
  creditAccount: async () => null,
}));
vi.mock('@/entities/credits/gas', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  keepGasReady: (...args: unknown[]) => h.keepGasReady(...args),
}));
vi.mock('@/shared/lib/online', () => ({
  subscribeOnline: (cb: (online: boolean) => void) => {
    h.online.listeners.add(cb);
    cb(h.online.now);
    return () => h.online.listeners.delete(cb);
  },
}));
vi.mock('@/entities/credits/credits', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchClaims: (...args: unknown[]) => h.fetchClaims(...args),
  creditBlocksAt: (...args: unknown[]) => h.creditBlocksAt(...args),
  creditStateAt: (...args: unknown[]) => h.creditStateAt(...args),
}));

vi.mock('@/entities/credits/selections', () => ({
  fetchSelections: (...args: unknown[]) => h.fetchSelections(...args),
  selectCollections: (...args: unknown[]) => h.selectCollections(...args),
}));
vi.mock('@/entities/credits/preview', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadMintPreviewsMany: (...args: unknown[]) => h.previews(...args),
}));

/** A credit as the store keys it. */
const KEY_CC = 'cc'.repeat(32);

/** A stream the test pushes by hand, shaped like a client's block streams. */
function subject<T>() {
  const observers = new Set<{ next: (value: T) => void }>();
  return {
    stream: {
      subscribe: (observer: { next: (value: T) => void }) => {
        observers.add(observer);
        return { unsubscribe: () => observers.delete(observer) };
      },
    },
    emit: (value: T) => {
      for (const observer of [...observers]) observer.next(value);
    },
  };
}

/** One credit, earned and waiting for its root. */
const creditsRead = () => ({
  credits: [{ hash: KEY_CC, awardBlock: 11, claimable: false }],
  watch: { rootless: [11], awaitingTree: [], unclaimed: [] },
  peopleSignature: 'blocks 11',
});

const KEY_DD = 'dd'.repeat(32);

/** Credits whose root is on Asset Hub: an NFT can be minted from each, and
 *  each carries its proof. */
const claimableRead = (keys: string[]) => ({
  credits: keys.map((key, leafIndex) => ({ hash: key, awardBlock: 11, claimable: true, leafIndex, proof: ['0xsib'] })),
  watch: { rootless: [], awaitingTree: [], unclaimed: [] },
  peopleSignature: 'blocks 11',
});

const never = () => new Promise<never>(() => {});

/** Every pair would mint item 3, with its picture or still without it. */
const mints = (extra: object) => async (pairs: unknown[]) =>
  pairs.map(() => ({ outcome: { kind: 'mints', item: 3, name: 'Mocha', ...extra } }));
const mintsWithPicture = mints({ imageUrl: 'https://gw.example/ipfs/bafypicture' });
const mintsWithoutPicture = mints({ artPending: true });

let nfts: Map<string, unknown>;
let assetHub: ReturnType<typeof fakeAssetHub>;
let assetHubBlocks: ReturnType<typeof subject<{ hash: string; number: number }[]>>;
let peopleBlocks: ReturnType<typeof subject<{ hash: string; number: number }[]>>;
let block = 0;

/** How many times the NFTs were read from Asset Hub. */
const nftReads = () => assetHub.spies.nftsByOwner.mock.calls.length;

/** Lets the reads that are due run, each passing its result to the next. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 8; turn++) await vi.advanceTimersByTimeAsync(0);
}

/** The host names another player. */
function switchPlayer(player: string): void {
  h.player = player;
  for (const cb of [...h.playerListeners]) cb(player);
}

/** The device losing or finding its network. */
function setOnline(online: boolean): void {
  h.online.now = online;
  for (const cb of [...h.online.listeners]) cb(online);
}

/** A new block on Asset Hub, and the watches' checks on it. */
async function newAssetHubBlock(): Promise<void> {
  block++;
  assetHubBlocks.emit([{ hash: `0xa${block}`, number: block }]);
  await settle();
}

async function newPeopleBlock(): Promise<void> {
  block++;
  peopleBlocks.emit([{ hash: `0xb${block}`, number: block }]);
  await vi.advanceTimersByTimeAsync(0);
}

/** A fresh sync, store and status: the sync starts once per page. */
async function start() {
  vi.resetModules();
  // In Node the query library takes itself to be on a server, where it does not repeat a query.
  (await import('@tanstack/query-core')).environmentManager.setIsServer(() => false);
  const sync = await import('./sync');
  const { collectiblesStore: store, entriesOf } = await import('@/entities/nfts/collectibles');
  const status = await import('@/shared/chain/status');
  const seen = { failing: false, status: 'idle' as string };
  status.subscribeRefreshFailing((failing) => {
    seen.failing = failing;
  });
  status.subscribeChainSyncStatus((next) => {
    seen.status = next;
  });
  sync.startChainSync();
  await settle();
  return {
    store,
    seen,
    /** What the grid shows, in no particular order. */
    hashes: () =>
      entriesOf(store.getState())
        .map((entry) => entry.hash)
        .sort(),
    /** Which parts the reads have brought this session. */
    known: () => ({ items: store.getState().nftsRead, credits: store.getState().creditsKnown }),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  h.live = true;
  h.online.now = true;
  h.online.listeners.clear();
  h.purse = { status: 'ready', id: 0 };
  h.player = ALICE_42;
  h.playerListeners.clear();
  nfts = new Map<string, unknown>([['addr-0', nft({ instance: 5n })]]);
  assetHub = fakeAssetHub({ nftsByOwner: nfts });
  h.accounts = () => [...nfts.keys()];
  assetHubBlocks = subject();
  peopleBlocks = subject();
  const apis = {
    assetHub: assetHub.api,
    people: fakePeople().api,
    raw: {
      assetHub: {
        ...(fakeRawClient() as object),
        bestBlocks$: assetHubBlocks.stream,
      },
      people: { bestBlocks$: peopleBlocks.stream },
    },
  };
  h.getChainApis.mockReset().mockResolvedValue(apis);
  h.fetchClaims.mockReset().mockImplementation(async () => creditsRead());
  h.fetchSelections.mockReset().mockResolvedValue(new Map());
  h.selectCollections.mockReset().mockReturnValue(new Map());
  h.previews.mockReset().mockImplementation(mintsWithPicture);
  h.creditBlocksAt.mockReset().mockResolvedValue('blocks 11');
  h.creditStateAt.mockReset().mockResolvedValue('');
  h.keepGasReady.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the chain sync', () => {
  it('shows the NFTs while the credits read hangs, and shows it could not refresh', async () => {
    h.fetchClaims.mockImplementation(never);
    const { seen, hashes, known } = await start();

    expect(hashes()).toEqual(['instance-5']);
    expect(known()).toEqual({ items: true, credits: false });
    expect(seen.failing).toBe(false);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(seen.failing).toBe(true);
    expect(seen.status).toBe('ok');

    // The NFTs keep updating meanwhile: the purse lists one more account.
    nfts.set('addr-1', nft({ instance: 6n }));
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(hashes()).toEqual(['instance-5', 'instance-6']);
  });

  it('stores each credit with the collection selected for it, from the same read', async () => {
    const selection = { selectedCollectionId: '27', selectedBy: 'dim2.paseo', selectedAt: 300 };
    h.selectCollections.mockReturnValue(new Map([[KEY_CC, selection]]));
    const { store } = await start();
    expect(store.getState().records[`c:${KEY_CC}`]).toMatchObject(selection);
    expect(store.getState().selectionsRead).toBe(true);
  });

  it('leaves the collections as kept when the stored selections could not be read', async () => {
    h.fetchSelections.mockResolvedValue(null);
    const { store } = await start();
    expect(h.selectCollections).not.toHaveBeenCalled();
    expect(store.getState().records[`c:${KEY_CC}`]).toBeDefined();
    expect(store.getState().selectionsRead).toBe(false);
  });

  it('reads the credits again when the list of collections changes', async () => {
    await start();
    const { collectionsStore } = await import('@/entities/collections/collectionsStore');
    const readsBefore = h.fetchClaims.mock.calls.length;
    collectionsStore.getState().read([{ id: 27, name: 'Coffee and Tea' }]);
    await settle();
    expect(h.fetchClaims.mock.calls.length).toBe(readsBefore + 1);
  });

  it('drops the credits read of a player who has left, so it never writes over the new one', async () => {
    let finishFirstRead = (_read: unknown): void => {};
    h.fetchClaims
      .mockImplementationOnce(() => new Promise((resolve) => (finishFirstRead = resolve)))
      .mockImplementationOnce(async () => ({ ...claimableRead([]), credits: [] }));
    const { store, hashes } = await start();

    switchPlayer('bob');
    await settle();
    finishFirstRead(claimableRead([KEY_CC]));
    await settle();

    expect(store.getState().owner).toBe('a:bob|');
    expect(hashes()).not.toContain(KEY_CC);
  });

  it('reports nothing for a credits read that only lost its block, and reads again at once', async () => {
    const lost = Object.assign(new Error('Block 0xab is not pinned'), { name: 'BlockNotPinnedError' });
    h.fetchClaims.mockRejectedValueOnce(lost);
    const { seen, hashes } = await start();
    expect(seen.failing).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(hashes()).toContain(KEY_CC);
    expect(seen.failing).toBe(false);
  });

  it('opens on the credits alone when the host has no purses', async () => {
    h.purse = { status: 'hostWithoutPurses' };
    const { hashes, known } = await start();
    expect(known()).toEqual({ items: true, credits: true });
    expect(hashes()).toEqual([KEY_CC]);
    expect(nftReads()).toBe(0);
  });

  it('knows there are no credits when the host serves no People Chain', async () => {
    const apis = (await h.getChainApis()) as object;
    h.getChainApis.mockResolvedValue({ ...apis, people: null });
    const { hashes, known } = await start();
    expect(known()).toEqual({ items: true, credits: true });
    expect(hashes()).toEqual(['instance-5']);
    expect(h.fetchClaims).not.toHaveBeenCalled();
  });

  it('shows the credits while the NFT read hangs', async () => {
    assetHub.spies.nftsByOwner.mockReturnValue(never());
    const { seen, hashes, known } = await start();

    expect(hashes()).toEqual([KEY_CC]);
    expect(known()).toEqual({ items: false, credits: true });

    // Four tries of 30 seconds each, 1, 2 and 4 seconds apart.
    await vi.advanceTimersByTimeAsync(128_000);
    await settle();
    expect(seen.status).toBe('error');
    expect(seen.failing).toBe(true);
  });

  it('reads both parts again at once when the network comes back, past a read still hanging', async () => {
    h.fetchClaims.mockImplementation(never);
    await start();
    const credits = h.fetchClaims.mock.calls.length;
    const reads = nftReads();

    setOnline(false);
    await settle();
    expect([h.fetchClaims.mock.calls.length, nftReads()]).toEqual([credits, reads]);

    setOnline(true);
    await settle();
    expect([h.fetchClaims.mock.calls.length, nftReads()]).toEqual([credits + 1, reads + 1]);
  });

  it('clears the note once the failing part reads again', async () => {
    h.fetchClaims.mockRejectedValueOnce(new Error('People Chain unreachable'));
    const { seen, hashes } = await start();
    expect(seen.failing).toBe(true);
    expect(hashes()).toEqual(['instance-5']);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(seen.failing).toBe(false);
    expect(hashes()).toEqual([KEY_CC, 'instance-5'].sort());
  });

  it('reads the NFTs again when the purse lists another account, and not before', async () => {
    const { hashes } = await start();
    const reads = nftReads();

    // The same list 5 seconds later reads nothing.
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(nftReads()).toBe(reads);

    nfts.set('addr-1', nft({ instance: 6n }));
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(nftReads()).toBe(reads + 1);
    expect(hashes()).toEqual([KEY_CC, 'instance-5', 'instance-6'].sort());
  });

  it('reads the credits again when the People Chain side changes, and not before', async () => {
    await start();
    expect(h.fetchClaims).toHaveBeenCalledTimes(1);

    await newPeopleBlock();
    expect(h.fetchClaims).toHaveBeenCalledTimes(1);

    h.creditBlocksAt.mockResolvedValue('blocks 11, 12');
    await vi.advanceTimersByTimeAsync(5_000);
    await newPeopleBlock();
    expect(h.fetchClaims).toHaveBeenCalledTimes(2);
  });

  it('reads both parts again when a claim shows on Asset Hub', async () => {
    h.fetchClaims.mockImplementation(async () => ({
      ...creditsRead(),
      watch: { rootless: [], awaitingTree: [], unclaimed: [{ block: 11, leaves: [0] }] },
    }));
    await start();
    const reads = nftReads();

    h.creditStateAt.mockResolvedValue('leaf 11:0');
    await newAssetHubBlock();
    expect(h.fetchClaims).toHaveBeenCalledTimes(2);
    expect(nftReads()).toBeGreaterThan(reads);
  });

  it('polls the credits as a backup when nothing else asks', async () => {
    await start();
    expect(h.fetchClaims).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(h.fetchClaims).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.fetchClaims).toHaveBeenCalledTimes(2);
  });

  it('reads the NFTs again 30 seconds after the last read when nothing else asks', async () => {
    await start();
    const reads = nftReads();

    await vi.advanceTimersByTimeAsync(29_000);
    await settle();
    expect(nftReads()).toBe(reads);
    await vi.advanceTimersByTimeAsync(1_500);
    await settle();
    expect(nftReads()).toBe(reads + 1);
  });

  it('replaces a connection only when its chain has stopped making blocks', async () => {
    assetHub.spies.nftsByOwner.mockRejectedValue(new Error('socket closed'));
    await start();
    // The read failed its four tries, 1, 2 and 4 seconds apart, on a chain that still makes blocks.
    await vi.advanceTimersByTimeAsync(8_000);
    await settle();
    expect(h.rebuildChain).not.toHaveBeenCalled();

    h.live = false;
    await vi.advanceTimersByTimeAsync(40_000);
    await settle();
    expect(h.rebuildChain).toHaveBeenCalledWith('assetHub');
  });
});

describe('what the credits would mint', () => {
  /** The credits read brings credit `key`, which goes to collection 27. */
  const goesTo27 = (...keys: string[]) => new Map(keys.map((key) => [key, { selectedCollectionId: '27' }] as const));
  const pair = (key: string) => ({ credit: `0x${key}`, collection: 27 });

  it('is read the moment a credit goes to a collection, once, and kept on its record', async () => {
    h.selectCollections.mockReturnValue(goesTo27(KEY_CC));
    const { store } = await start();
    expect(h.previews.mock.calls).toEqual([[[pair(KEY_CC)]]]);
    const kept = store.getState().records[`c:${KEY_CC}`]?.collectionItems?.['27'];
    expect(kept?.item).toMatchObject({ name: 'Mocha', collectionIndex: 4, hasArt: true });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.previews).toHaveBeenCalledTimes(1);
  });

  it('is not read while no credit goes to a collection', async () => {
    await start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.previews).not.toHaveBeenCalled();
  });

  it('is read again every 15 seconds while a picture was not served, and no more once it came', async () => {
    h.selectCollections.mockReturnValue(goesTo27(KEY_CC));
    h.previews.mockImplementation(mintsWithoutPicture);
    const { store } = await start();
    expect(h.previews).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.previews).toHaveBeenCalledTimes(2);
    h.previews.mockImplementation(mintsWithPicture);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.previews).toHaveBeenCalledTimes(3);
    expect(store.getState().records[`c:${KEY_CC}`]?.collectionItems?.['27']?.item?.hasArt).toBe(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.previews).toHaveBeenCalledTimes(3);
  });

  it('is read again within 15 seconds of a read that failed', async () => {
    h.selectCollections.mockReturnValue(goesTo27(KEY_CC));
    h.previews.mockRejectedValue(new Error('no chain connection this session'));
    const { store } = await start();
    expect(store.getState().records[`c:${KEY_CC}`]?.collectionItems).toBeUndefined();
    h.previews.mockImplementation(mintsWithPicture);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(store.getState().records[`c:${KEY_CC}`]?.collectionItems?.['27']?.item?.name).toBe('Mocha');
  });

  it('is read for a credit that came while a read ran, as soon as that read ends', async () => {
    h.selectCollections.mockReturnValue(goesTo27(KEY_CC, KEY_DD));
    let endFirstRead = (): void => {};
    h.previews.mockImplementationOnce(
      (pairs: unknown[]) =>
        new Promise((resolve) => {
          endFirstRead = () => resolve(mintsWithPicture(pairs));
        }),
    );
    const { store } = await start();
    expect(h.previews.mock.calls).toEqual([[[pair(KEY_CC)]]]);

    h.fetchClaims.mockImplementation(async () => claimableRead([KEY_CC, KEY_DD]));
    await vi.advanceTimersByTimeAsync(1_000);
    setOnline(false);
    setOnline(true);
    await settle();
    expect(store.getState().records[`c:${KEY_DD}`]).toBeDefined();
    expect(h.previews).toHaveBeenCalledTimes(1);

    endFirstRead();
    await settle();
    expect(h.previews.mock.calls[1]).toEqual([[pair(KEY_DD)]]);
    expect(store.getState().records[`c:${KEY_DD}`]?.collectionItems?.['27']?.item?.name).toBe('Mocha');
  });
});

describe('another player', () => {
  it('never sees the records kept for the one before, even while every read hangs', async () => {
    const { store } = await start();
    expect(Object.keys(store.getState().records)).not.toHaveLength(0);
    h.fetchClaims.mockImplementation(never);
    h.accounts = () => never() as never;
    switchPlayer('5Other');
    expect(store.getState()).toMatchObject({ owner: 'a:5Other|', records: {} });
  });
});

describe('the gas for a mint', () => {
  it('is left alone while no NFT can be minted from a credit', async () => {
    await start();
    expect(h.keepGasReady).not.toHaveBeenCalled();
  });

  it('is moved ahead when a read brings a credit an NFT can be minted from, and again only for more credits', async () => {
    h.fetchClaims.mockImplementation(async () => claimableRead([KEY_CC]));
    await start();
    expect(h.keepGasReady).toHaveBeenCalledTimes(1);
    expect(h.keepGasReady.mock.calls[0]?.slice(0, 2)).toEqual([assetHub.api, ALICE_42]);

    await vi.advanceTimersByTimeAsync(30_000);
    await settle();
    expect(h.fetchClaims.mock.calls.length).toBeGreaterThan(1);
    expect(h.keepGasReady).toHaveBeenCalledTimes(1);

    h.fetchClaims.mockImplementation(async () => claimableRead([KEY_CC, KEY_DD]));
    await vi.advanceTimersByTimeAsync(30_000);
    await settle();
    expect(h.keepGasReady).toHaveBeenCalledTimes(2);
  });
});
