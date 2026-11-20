// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StateStorage } from 'zustand/middleware';

import type { ResolvedCollectible } from '@/entities/art/resolver';

import {
  type CollectionItemRead,
  createCollectiblesStore,
  type Credit,
  EMPTY_KEPT,
  entriesOf,
  entryOf,
  MAX_NFTS,
  MINT_GRACE_MS,
  onCollectionItemsRead,
  onCreditSpent,
  onCreditsRead,
  onMint,
  onMintFailed,
  onNftsRead,
  onProofRefused,
  type SelectedCollection,
  selectedCollectionItemOf,
  SESSION_STARTED_AT,
  usableKept,
} from './collectibles';
import type { OwnedNft } from './types';

const ME = 'a:me|';

const look = (name: string, extra: Partial<ResolvedCollectible> = {}): ResolvedCollectible => ({
  url: `https://gw/ipfs/bafy${name}`,
  name,
  hasArt: true,
  isRare: false,
  glow: '1 2 3',
  collectionIndex: 4,
  ...extra,
});

const nft = (n: number, extra: Partial<OwnedNft> = {}): OwnedNft => ({
  hash: `instance-${String(n)}`,
  instance: String(n),
  purse: `purse-${String(n)}`,
  collectionId: '27',
  itemIndex: 3,
  name: `Piece ${String(n)}`,
  imageUrl: `https://gw/ipfs/bafy${String(n)}`,
  mintedAt: 1_000 + n,
  ...extra,
});

const credit = (hash: string, extra: Partial<Credit> = {}): Credit => ({
  hash,
  awardBlock: 7,
  awardedAt: 500,
  claimable: true,
  leafIndex: 2,
  proof: ['0xsib'],
  ...extra,
});

/** A time in this session, and one in an earlier session. */
const THIS_SESSION = SESSION_STARTED_AT + 1_000;
const EARLIER_SESSION = SESSION_STARTED_AT - 500;

afterEach(() => {
  vi.useRealTimers();
});

/** A read of what credit `aa` would mint in `collectionId`. */
const itemRead = (
  collectionId: string,
  item: ResolvedCollectible | null,
  readAt = THIS_SESSION,
): CollectionItemRead => ({
  credit: 'aa',
  collectionId,
  item,
  readAt,
});

/** The selections of one read: credit `hash` goes to `selectedCollectionId`. */
const selected = (hash: string, selectedCollectionId: string, by: Partial<SelectedCollection> = {}) =>
  new Map<string, SelectedCollection>([[hash, { selectedCollectionId, ...by }]]);

describe('an NFT read', () => {
  it('returns the very same records when it brings nothing new', () => {
    const first = onNftsRead(EMPTY_KEPT, ME, [nft(1), nft(2)]);
    expect(onNftsRead(first, ME, [nft(1), nft(2)])).toBe(first);
  });

  it('touches only the record that changed: the others keep their objects', () => {
    const first = onNftsRead(EMPTY_KEPT, ME, [nft(1), nft(2)]);
    const next = onNftsRead(first, ME, [nft(1, { name: 'Renamed' }), nft(2)]);
    expect(next.records['i:2']).toBe(first.records['i:2']);
    expect(next.records['i:1']).not.toBe(first.records['i:1']);
  });

  it('gives an NFT with no record one of its own, timed from its mint', () => {
    const k = onNftsRead(EMPTY_KEPT, ME, [nft(9)]);
    expect(k.records['i:9']).toMatchObject({ id: 'i:9', type: 'nft', acquiredAt: 1_009 });
    expect(k.owner).toBe(ME);
  });

  it('lets an NFT go only when an NFT read no longer finds it, and leaves credits alone', () => {
    const k = onCreditsRead(onNftsRead(EMPTY_KEPT, ME, [nft(1), nft(2)]), ME, [credit('aa')], null);
    const next = onNftsRead(k, ME, [nft(2)]);
    expect(Object.keys(next.records).sort()).toEqual(['c:aa', 'i:2']);
    expect(next.records['c:aa']).toBe(k.records['c:aa']);
  });

  it('drops new NFTs past the cap and counts them, while kept ones still update', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const many = Array.from({ length: MAX_NFTS + 1 }, (_, i) => nft(i));
    const k = onNftsRead(EMPTY_KEPT, ME, many);
    expect(Object.keys(k.records)).toHaveLength(MAX_NFTS);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('dropped 1'));
    warn.mockRestore();
  });

  it('counts an NFT the read brings twice once toward the cap', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const twice = [...Array.from({ length: MAX_NFTS - 1 }, (_, i) => nft(i)), nft(0), nft(MAX_NFTS)];
    const k = onNftsRead(EMPTY_KEPT, ME, twice);
    expect(Object.keys(k.records)).toHaveLength(MAX_NFTS);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('finds the record of an NFT by its instance when the read gives another item hash', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const minted = onMint(onCreditsRead(EMPTY_KEPT, ME, [credit('aa')], null), ME, { credit: 'aa', nft: nft(5) });
    vi.setSystemTime(MINT_GRACE_MS + 1);
    const read = onNftsRead(minted, ME, [nft(5, { hash: '0xbeef' })]);
    expect(Object.keys(read.records)).toEqual(['c:aa']);
    expect(read.records['c:aa']?.nft?.hash).toBe('0xbeef');
  });

  it("never mixes another player's records into this one", () => {
    const mine = onNftsRead(EMPTY_KEPT, ME, [nft(1)]);
    const theirs = onNftsRead(mine, 'a:them|', [nft(2)]);
    expect(Object.keys(theirs.records)).toEqual(['i:2']);
    expect(theirs.owner).toBe('a:them|');
  });
});

describe('a credits read', () => {
  it('times a credit once its root lands, and never changes that time', () => {
    const rootless = onCreditsRead(EMPTY_KEPT, ME, [credit('aa', { awardedAt: undefined })], null);
    expect(rootless.records['c:aa']?.acquiredAt).toBeUndefined();
    const rooted = onCreditsRead(rootless, ME, [credit('aa', { awardedAt: 600 })], null);
    expect(rooted.records['c:aa']?.acquiredAt).toBe(600);
    const later = onCreditsRead(rooted, ME, [credit('aa', { awardedAt: 900 })], null);
    expect(later.records['c:aa']?.acquiredAt).toBe(600);
  });

  it('keeps the proof each claimable credit spends', () => {
    const k = onCreditsRead(EMPTY_KEPT, ME, [credit('0xAA')], null);
    expect(k.records['c:aa']?.credit).toMatchObject({ hash: 'aa', leafIndex: 2, proof: ['0xsib'] });
  });

  it('lets a credit go when a read no longer brings it, and leaves NFTs alone', () => {
    const k = onNftsRead(onCreditsRead(EMPTY_KEPT, ME, [credit('aa'), credit('bb')], null), ME, [nft(1)]);
    const next = onCreditsRead(k, ME, [credit('bb')], null);
    expect(Object.keys(next.records).sort()).toEqual(['c:bb', 'i:1']);
    expect(next.records['i:1']).toBe(k.records['i:1']);
  });

  it('keeps the NFT minted here from a credit, whatever the read still holds', () => {
    const minted = onMint(onCreditsRead(EMPTY_KEPT, ME, [credit('aa')], null), ME, { credit: 'aa', nft: nft(5) });
    const next = onCreditsRead(minted, ME, [credit('aa')], null);
    expect(next.records['c:aa']).toBe(minted.records['c:aa']);
    expect(next.records['c:aa']?.type).toBe('nft');
  });
});

describe('the collection a credit goes to', () => {
  const HERE = { selectedBy: 'dim2.paseo', selectedAt: 500 };

  it('comes with the credits read, with the product and the time of its selection', () => {
    const k = onCreditsRead(EMPTY_KEPT, ME, [credit('aa')], selected('aa', '27', HERE));
    expect(k.records['c:aa']).toMatchObject({ selectedCollectionId: '27', ...HERE });
  });

  it('loses the product and the time when a later read sends the credit to its default', () => {
    const first = onCreditsRead(EMPTY_KEPT, ME, [credit('aa')], selected('aa', '27', HERE));
    const next = onCreditsRead(first, ME, [credit('aa')], selected('aa', '27')).records['c:aa']!;
    expect(next.selectedCollectionId).toBe('27');
    expect(next.selectedBy).toBeUndefined();
    expect(next.selectedAt).toBeUndefined();
  });

  it('stays as kept when the selections could not be read', () => {
    const first = onCreditsRead(EMPTY_KEPT, ME, [credit('aa')], selected('aa', '27', HERE));
    expect(onCreditsRead(first, ME, [credit('aa')], null)).toBe(first);
  });

  it('keeps the item read for the collection before when the collection changes', () => {
    const read27 = onCollectionItemsRead(onCreditsRead(EMPTY_KEPT, ME, [credit('aa')], selected('aa', '27')), [
      itemRead('27', look('Mocha')),
    ]);
    const moved = onCreditsRead(read27, ME, [credit('aa')], selected('aa', '28', HERE)).records['c:aa']!;
    expect(moved).toMatchObject({ selectedCollectionId: '28', ...HERE });
    expect(moved.collectionItems?.['27']?.item?.name).toBe('Mocha');
    expect(selectedCollectionItemOf(moved)).toBeUndefined();
  });
});

describe('a mint', () => {
  it("turns the credit's record into its NFT in place, keeping its time and the item it would mint", () => {
    const k = onCollectionItemsRead(onCreditsRead(EMPTY_KEPT, ME, [credit('aa')], selected('aa', '27')), [
      itemRead('27', look('Mocha')),
    ]);
    const minted = onMint(k, ME, {
      credit: 'aa',
      nft: { hash: 'instance-5', instance: '5', purse: 'p', collectionId: '27', itemIndex: 3 },
    });
    const r = minted.records['c:aa']!;
    expect(r).toMatchObject({ id: 'c:aa', type: 'nft', acquiredAt: 500, credit: { hash: 'aa' } });
    expect(minted.order).toEqual(['c:aa']);
    const entry = entryOf(r)!;
    expect(entry).toMatchObject({ hash: 'instance-5', pending: false, fromCredit: 'aa', acquiredAt: 500 });
    expect(entry.resolved.name).toBe('Mocha');
  });

  it('stands through reads that do not show it yet, takes the name a read gives, and goes past the grace', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const minted = onMint(onCreditsRead(EMPTY_KEPT, ME, [credit('aa')], null), ME, {
      credit: 'aa',
      nft: nft(5, { name: undefined }),
    });
    vi.setSystemTime(1_000 + MINT_GRACE_MS - 1);
    const early = onNftsRead(minted, ME, []);
    expect(early.records['c:aa']?.type).toBe('nft');
    vi.setSystemTime(1_000 + 60_000);
    const named = onNftsRead(early, ME, [nft(5)]);
    expect(named.records['c:aa']).toMatchObject({ nft: { name: 'Piece 5' } });
    expect(named.records['c:aa']?.mintedHere).toBeUndefined();
    expect(Object.keys(named.records)).toEqual(['c:aa']);
    vi.setSystemTime(1_000 + MINT_GRACE_MS + 1);
    const gone = onNftsRead(minted, ME, []);
    expect(gone.records['c:aa']).toBeUndefined();
  });

  it("folds an NFT a read brought before the event into the credit's record", () => {
    const k = onNftsRead(onCreditsRead(EMPTY_KEPT, ME, [credit('aa')], null), ME, [nft(5)]);
    const minted = onMint(k, ME, { credit: 'aa', nft: { hash: 'instance-5', instance: '5' } });
    expect(Object.keys(minted.records)).toEqual(['c:aa']);
    expect(minted.records['c:aa']).toMatchObject({ nft: { name: 'Piece 5' }, acquiredAt: 500 });
    expect(minted.records['c:aa']?.mintedHere).toBeUndefined();
  });

  it("counts a piece minted here as arrived at the mint, until a read brings the chain's own time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_790_000_123_456);
    const k = onCreditsRead(EMPTY_KEPT, ME, [credit('aa')], null);
    const minted = onMint(k, ME, { credit: 'aa', nft: { hash: 'instance-5', instance: '5' } });
    expect(minted.records['c:aa']?.nft?.lastMoved).toBe(1_790_000_123);
    vi.setSystemTime(1_790_000_123_456 + 60_000);
    const read = onNftsRead(minted, ME, [nft(5, { lastMoved: 1_790_000_100 })]);
    expect(read.records['c:aa']?.nft?.lastMoved).toBe(1_790_000_100);
  });

  it('writes a failed mint on the credit, and drops it once a mint lands', () => {
    const k = onCreditsRead(EMPTY_KEPT, ME, [credit('aa')], null);
    const failed = onMintFailed(k, 'aa', 'transient');
    expect(failed.records['c:aa']?.mintFailure).toBe('transient');
    expect(failed.records['c:aa']?.mintFailedAt).toBeGreaterThanOrEqual(SESSION_STARTED_AT);
    expect(onMintFailed(k, 'zz', 'transient')).toBe(k);
    const minted = onMint(failed, ME, { credit: 'aa', nft: nft(5) }).records['c:aa']!;
    expect(minted.mintFailure).toBeUndefined();
    expect(minted.mintFailedAt).toBeUndefined();
  });

  it('drops a proof the chain rejected, so the next claim asks for a fresh one', () => {
    const k = onProofRefused(onCreditsRead(EMPTY_KEPT, ME, [credit('aa')], null), 'aa');
    expect(k.records['c:aa']?.credit).toEqual({ hash: 'aa', awardBlock: 7, awardedAt: 500, claimable: true });
    expect(onProofRefused(k, 'aa')).toBe(k);
  });

  it('a credit spent with no NFT named leaves, and the read brings its NFT as its own', () => {
    const k = onCreditSpent(onCreditsRead(EMPTY_KEPT, ME, [credit('aa')], null), 'aa');
    expect(k.records['c:aa']).toBeUndefined();
    expect(onCreditSpent(k, 'aa')).toBe(k);
  });
});

describe('what a credit would mint', () => {
  const base = () => onCreditsRead(EMPTY_KEPT, ME, [credit('aa')], selected('aa', '27'));

  it('is kept under its collection, also for a collection the credit does not go to', () => {
    const k = onCollectionItemsRead(base(), [itemRead('27', look('Mocha')), itemRead('28', look('Chef'))]);
    const r = k.records['c:aa']!;
    expect(r.collectionItems).toEqual({
      '27': { item: look('Mocha'), readAt: THIS_SESSION },
      '28': { item: look('Chef'), readAt: THIS_SESSION },
    });
    expect(selectedCollectionItemOf(r)?.item?.name).toBe('Mocha');
  });

  it('is kept with no item when the credit would mint nothing there', () => {
    const k = onCollectionItemsRead(base(), [itemRead('28', null)]);
    expect(k.records['c:aa']?.collectionItems?.['28']).toEqual({ item: null, readAt: THIS_SESSION });
  });

  it('writes nothing when the same item is read again in one session', () => {
    const first = onCollectionItemsRead(base(), [itemRead('27', look('Mocha')), itemRead('28', null)]);
    const again = [itemRead('27', look('Mocha'), THIS_SESSION + 1_000), itemRead('28', null, THIS_SESSION + 1_000)];
    expect(onCollectionItemsRead(first, again)).toBe(first);
  });

  it('takes the time of the new read when the one kept is from an earlier session', () => {
    const earlier = onCollectionItemsRead(base(), [itemRead('27', look('Mocha'), EARLIER_SESSION)]);
    const next = onCollectionItemsRead(earlier, [itemRead('27', look('Mocha'))]);
    expect(next.records['c:aa']?.collectionItems?.['27']).toEqual({ item: look('Mocha'), readAt: THIS_SESSION });
  });

  it('never swaps an item with its picture for the same item read without it', () => {
    const first = onCollectionItemsRead(base(), [itemRead('27', look('Mocha'), EARLIER_SESSION)]);
    const bare = look('Mocha', { hasArt: false, artPending: true });
    const next = onCollectionItemsRead(first, [itemRead('27', bare)]);
    expect(next.records['c:aa']?.collectionItems?.['27']).toEqual({ item: look('Mocha'), readAt: THIS_SESSION });
  });

  it('takes another item, whether its picture came or not', () => {
    const first = onCollectionItemsRead(base(), [itemRead('27', look('Mocha'), EARLIER_SESSION)]);
    const other = look('Latte', { hasArt: false, collectionIndex: 9 });
    const next = onCollectionItemsRead(first, [itemRead('27', other)]);
    expect(next.records['c:aa']?.collectionItems?.['27']?.item).toEqual(other);
  });

  it('is not kept on a record that is no credit', () => {
    const minted = onMint(base(), ME, { credit: 'aa', nft: nft(5) });
    expect(onCollectionItemsRead(minted, [itemRead('27', look('Mocha'))])).toBe(minted);
  });
});

describe('the order', () => {
  it('puts a rootless credit first, then the newest earned, and an undated NFT last', () => {
    let k = onNftsRead(EMPTY_KEPT, ME, [
      nft(1, { mintedAt: 100 }),
      nft(2, { mintedAt: undefined }),
      nft(3, { mintedAt: 300 }),
    ]);
    k = onCreditsRead(k, ME, [credit('aa', { awardedAt: undefined }), credit('bb', { awardedAt: 200 })], null);
    expect(k.order).toEqual(['c:aa', 'i:3', 'c:bb', 'i:1', 'i:2']);
    expect(entriesOf(k).map((e) => e.hash)).toEqual(['aa', 'instance-3', 'bb', 'instance-1', 'instance-2']);
  });
});

describe('the store', () => {
  const memory = (): StateStorage & { data: Map<string, string> } => {
    const data = new Map<string, string>();
    return {
      data,
      getItem: (k) => data.get(k) ?? null,
      setItem: (k, v) => void data.set(k, v),
      removeItem: (k) => void data.delete(k),
    };
  };

  it('saves the records and reads them back with rehydrate, never the session flags', async () => {
    const storage = memory();
    const first = createCollectiblesStore(storage);
    first.getState().readNfts(ME, [nft(1)]);
    first.getState().readCredits(ME, [credit('aa')], null);
    expect(first.getState()).toMatchObject({ nftsRead: true, creditsKnown: true, selectionsRead: false });
    const next = createCollectiblesStore(storage);
    expect(next.getState().records).toEqual({});
    await next.persist.rehydrate();
    expect(Object.keys(next.getState().records).sort()).toEqual(['c:aa', 'i:1']);
    expect(next.getState()).toMatchObject({ nftsRead: false, creditsKnown: false, owner: ME });
  });

  it('writes nothing when a read brings nothing new', () => {
    const store = createCollectiblesStore(memory());
    store.getState().readNfts(ME, [nft(1)]);
    const before = store.getState();
    store.getState().readNfts(ME, [nft(1)]);
    expect(store.getState()).toBe(before);
  });

  it('starts the session over for another player', () => {
    const store = createCollectiblesStore(memory());
    store.getState().readNfts(ME, [nft(1)]);
    store.getState().readCredits('a:them|', [], null);
    expect(store.getState()).toMatchObject({ owner: 'a:them|', nftsRead: false, creditsKnown: true, records: {} });
  });

  it('marks the selections read only when a read brought them, and starts over for another player', () => {
    const store = createCollectiblesStore(memory());
    store.getState().readCredits(ME, [credit('aa')], null);
    expect(store.getState().selectionsRead).toBe(false);
    store.getState().readCredits(ME, [credit('aa')], selected('aa', '27'));
    expect(store.getState().selectionsRead).toBe(true);
    store.getState().readCredits('a:them|', [], null);
    expect(store.getState().selectionsRead).toBe(false);
  });

  it('drops the records kept for another player once the player is known', () => {
    const store = createCollectiblesStore(memory());
    store.getState().readNfts(ME, [nft(1)]);
    store.getState().setOwner(ME);
    expect(Object.keys(store.getState().records)).toEqual(['i:1']);
    store.getState().setOwner('a:them|');
    expect(store.getState()).toMatchObject({ owner: 'a:them|', nftsRead: false, records: {} });
  });

  it('saves what a credit would mint with its record', async () => {
    const storage = memory();
    const first = createCollectiblesStore(storage);
    first.getState().readCredits(ME, [credit('aa')], selected('aa', '27'));
    first.getState().readCollectionItems([itemRead('27', look('Mocha'), Date.now())]);
    const next = createCollectiblesStore(storage);
    await next.persist.rehydrate();
    const kept = next.getState().records['c:aa']!;
    expect(selectedCollectionItemOf(kept)?.item?.name).toBe('Mocha');
  });

  it('holds what the credits wait for in this session only, and drops it for another player', async () => {
    const storage = memory();
    const store = createCollectiblesStore(storage);
    store.getState().readCredits(ME, [credit('aa')], null);
    const watch = { rootless: [11], awaitingTree: [12], unclaimed: [{ block: 7, leaves: [2] }] };
    store.getState().setCreditWatch(watch);
    expect(store.getState().creditWatch).toBe(watch);
    const next = createCollectiblesStore(storage);
    await next.persist.rehydrate();
    expect(next.getState()).toMatchObject({ owner: ME, creditWatch: { rootless: [] } });
    store.getState().setOwner('a:them|');
    expect(store.getState().creditWatch).toEqual({ rootless: [], awaitingTree: [], unclaimed: [] });
  });

  it('keeps the credits as they were when there are none to read', () => {
    const store = createCollectiblesStore(memory());
    store.getState().readCredits(ME, [credit('aa')], null);
    store.getState().readCredits(ME, null, null);
    expect(Object.keys(store.getState().records)).toEqual(['c:aa']);
  });

  it('a kept record of another shape drops out', () => {
    const k = usableKept({
      owner: ME,
      records: {
        'i:1': { id: 'i:1', type: 'nft' },
        'c:aa': { id: 'c:aa', type: 'credit', credit: { hash: 'aa', awardBlock: 7 } },
      },
    });
    expect(Object.keys(k.records)).toEqual(['c:aa']);
  });
});
