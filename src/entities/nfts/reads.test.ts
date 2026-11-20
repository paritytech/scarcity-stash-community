// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

import type { NftPurseItemKey } from '@parity/product-sdk-host';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as Log from '@/shared/telemetry/log';

import type * as Reads from './reads';

vi.mock('@/shared/chain/client', () => ({ getChainApis: vi.fn() }));

import type { StepRecord } from '@/shared/telemetry/record';
import { hostError, publicKey } from '@/testing/fakeHost';
import { afterMs, answersAfterMs, neverAnswers, queryClientPerTest, settled } from '@/testing/queryTest';

import { accountPublicKeysQuery, nftsQuery, stashPurseQuery } from './queries';
import type { StashPurseStatus } from './stashPurse';
import type { OwnedNft } from './types';

let addSink: typeof Log.addSink;
let flushTelemetry: typeof Log.flushTelemetry;
let trackReads: typeof Reads.trackReads;

const { observe, queryClient } = queryClientPerTest();
const records: StepRecord[] = [];

// The lines the module wrote to the console. They open with [purses], unlike the lines of the records.
const logged: string[] = [];
const warned: string[] = [];
const keepIn = (lines: string[]) => (line: unknown) => {
  if (String(line).startsWith('[purses]')) lines.push(String(line));
};

// Fresh modules per test: no journey, record or sink carries over.
beforeEach(async () => {
  vi.resetModules();
  ({ addSink, flushTelemetry } = await import('@/shared/telemetry/log'));
  ({ trackReads } = await import('./reads'));
  logged.length = 0;
  warned.length = 0;
  vi.spyOn(console, 'log').mockImplementation(keepIn(logged));
  vi.spyOn(console, 'warn').mockImplementation(keepIn(warned));
  records.length = 0;
  addSink({ record: (record) => records.push(record) });
  trackReads(queryClient().getQueryCache());
});

afterEach(() => {
  vi.restoreAllMocks();
});

// The app's queries, each with the test's own result in place of the host or the chain.
const purseQuery = (lookUp: () => Promise<StashPurseStatus>) => ({ ...stashPurseQuery, queryFn: lookUp });
const accountsQuery = (list: () => Promise<NftPurseItemKey[]>) => ({ ...accountPublicKeysQuery(4), queryFn: list });
const nftQuery = (publicKeys: NftPurseItemKey[], read: () => Promise<OwnedNft[]>) => ({
  ...nftsQuery(publicKeys),
  queryFn: read,
});

const [alice, bob] = [publicKey(1), publicKey(2)];
const nft = (hash: string): OwnedNft => ({ hash });
const denied = hostError('Denied');

describe('the first reads of an app open', () => {
  it('are the steps of one journey, and each step waits as long as its read ran', async () => {
    await afterMs(5_000);
    observe(purseQuery(() => answersAfterMs(62, { status: 'ready', id: 4 })));
    await afterMs(62);
    observe(accountsQuery(() => answersAfterMs(84, [alice, bob])));
    await afterMs(84);
    observe(nftQuery([alice, bob], () => answersAfterMs(1_400, [nft('a'), nft('b')])));
    await afterMs(1_400);
    flushTelemetry();

    expect(records.map((record) => [record.journey, record.step, record.sincePrev, record.facts])).toEqual([
      ['read', 'start', 0, {}],
      ['read', 'purse found', 62, { ms: 62 }],
      ['read', 'accounts listed', 84, { count: 2, ms: 84 }],
      ['read', 'NFTs read', 1_400, { count: 2, ms: 1_400 }],
      ['read', 'done', 0, {}],
    ]);
  });

  it('end at once on a host without purses', async () => {
    observe(purseQuery(async () => ({ status: 'hostWithoutPurses' })));
    await settled();
    flushTelemetry();

    expect(records.map((record) => [record.step, record.facts])).toEqual([
      ['start', {}],
      ['done', { reason: 'the host has no purses' }],
    ]);
  });

  it('count as stalled when the next read takes longer than 60 seconds', async () => {
    observe(purseQuery(async () => ({ status: 'ready', id: 4 })));
    await settled();
    observe(accountsQuery(neverAnswers));
    await afterMs(59_999);
    flushTelemetry();

    expect(records.at(-1)).toMatchObject({ step: 'purse found', outcome: 'ok' });

    await afterMs(1);
    flushTelemetry();

    expect(records.at(-1)).toMatchObject({ step: 'purse found', outcome: 'stalled' });
  });

  it('give the purse lookup 60 seconds too', async () => {
    observe(purseQuery(neverAnswers));
    await afterMs(59_999);
    flushTelemetry();

    expect(records.map((record) => record.outcome)).toEqual(['ok']);

    await afterMs(1);
    flushTelemetry();

    expect(records.at(-1)).toMatchObject({ step: 'start', outcome: 'stalled' });
  });
});

describe('a later read', () => {
  it('writes one line when the account list differs from the one before', async () => {
    const list = vi
      .fn<() => Promise<NftPurseItemKey[]>>()
      .mockResolvedValueOnce([alice])
      .mockResolvedValueOnce([alice])
      .mockImplementation(() => answersAfterMs(90, [alice, bob]));

    observe(accountsQuery(list));
    await afterMs(5_000);

    expect(logged).toEqual([]);

    await afterMs(5_000 + 90);

    expect(logged).toEqual(['[purses] accounts listed: 2 in 90 ms']);
  });

  it('writes one line for the NFTs of a new list, and none when the same list is read again', async () => {
    const read = vi.fn<() => Promise<OwnedNft[]>>().mockResolvedValue([nft('a')]);

    const nfts = observe(nftQuery([alice], read));
    await afterMs(30_000);

    expect(read).toHaveBeenCalledTimes(2);
    expect(logged).toEqual([]);

    read.mockImplementation(() => answersAfterMs(1_400, [nft('a'), nft('b')]));
    nfts.setOptions(nftQuery([alice, bob], read));
    await afterMs(1_400);

    expect(logged).toEqual(['[purses] NFTs read: 2 in 1400 ms']);
  });

  it('is not a record', async () => {
    observe(accountsQuery(async () => [alice]));
    await afterMs(5_000);
    flushTelemetry();

    expect(records.map((record) => record.step)).toEqual(['start', 'accounts listed']);
  });

  it('is not taken from data set by hand', async () => {
    const list = vi
      .fn<() => Promise<NftPurseItemKey[]>>()
      .mockResolvedValueOnce([alice])
      .mockImplementation(() => answersAfterMs(2_000, [alice]));

    observe(accountsQuery(list));
    await afterMs(5_000 + 1_000);
    queryClient().setQueryData(accountPublicKeysQuery(4).queryKey, [alice, bob]);
    await settled();

    expect(logged).toEqual([]);
  });
});

describe('a read that fails', () => {
  it('writes one warning when it starts failing, and one line when it works again', async () => {
    const list = vi
      .fn<() => Promise<NftPurseItemKey[]>>()
      .mockResolvedValueOnce([alice])
      .mockRejectedValueOnce(denied)
      .mockRejectedValueOnce(denied)
      .mockRejectedValueOnce(denied)
      .mockResolvedValue([alice]);

    observe(accountsQuery(list));
    await afterMs(15_000);

    expect(warned).toEqual(['[purses] listing the accounts is failing: nftPurse failed: Denied']);
    expect(logged).toEqual([]);

    await afterMs(5_000);

    expect(logged).toEqual(['[purses] listing the accounts works again, failed tries: 3']);

    await afterMs(5_000);

    expect(warned).toHaveLength(1);
    expect(logged).toHaveLength(1);
  });

  it('counts every failed try of a read that is tried again', async () => {
    const lookUp = vi.fn<() => Promise<StashPurseStatus>>().mockResolvedValue({ status: 'ready', id: 4 });
    for (let failed = 0; failed < 5; failed++) lookUp.mockRejectedValueOnce(denied);

    observe(purseQuery(lookUp));
    await afterMs(1_000 + 2_000 + 4_000 + 8_000 + 16_000);

    expect(warned).toEqual(['[purses] finding the stash purse is failing: nftPurse failed: Denied']);
    expect(logged).toEqual(['[purses] finding the stash purse works again, failed tries: 5']);
  });
});

describe('a read no observer uses any more', () => {
  // The NFT read of the list before still finishes after the grid moved on to a new list.
  async function newListDuringRead(readOfListBefore: () => Promise<OwnedNft[]>) {
    const nfts = observe(nftQuery([alice], readOfListBefore));
    await afterMs(1_000);
    nfts.setOptions(nftQuery([alice, bob], () => answersAfterMs(2_000, [nft('a'), nft('b')])));
    await afterMs(2_000);
    flushTelemetry();
  }

  it('writes no line when it finishes, and does not make the next read look changed', async () => {
    await newListDuringRead(() => answersAfterMs(10_000, [nft('a')]));

    expect(records.find((record) => record.step === 'NFTs read')).toMatchObject({ facts: { count: 2 } });

    await afterMs(7_000 + 32_000);

    expect(logged).toEqual([]);
  });

  it('writes no warning when it fails', async () => {
    const failsLate = () =>
      new Promise<never>((_, reject) => globalThis.setTimeout(() => reject(new Error('the chain is away')), 10_000));

    await newListDuringRead(failsLate);
    await afterMs(7_000 + 32_000);

    expect(warned).toEqual([]);
    expect(logged).toEqual([]);
  });
});

it('a query without a read name is not measured', async () => {
  observe({ queryKey: ['other'], queryFn: async () => [alice] });
  await settled();
  flushTelemetry();

  expect(records).toEqual([]);
});
