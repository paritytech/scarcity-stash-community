// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// mintNftFromCredit is the one function that mints an NFT from a credit. These tests run it over
// a fake Asset Hub and a host that creates purse accounts, with the claim
// itself stubbed. They pin what each claim is given, the order mints run in,
// what the caller gets back, and the steps each credit's journey records. The
// last group runs the mints the app starts by itself, from the store.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ResolvedCollectible } from '@/entities/art/resolver';
import {
  type Collectible,
  collectiblesStore,
  EMPTY_KEPT,
  onCollectionItemsRead,
  onCreditsRead,
  SESSION_STARTED_AT,
} from '@/entities/nfts/collectibles';
import { queryClient } from '@/entities/nfts/queries';
import { recordsOwner } from '@/entities/player/identity';
import type { ChainApis } from '@/shared/chain/client';
import type { journey, JourneyHandle } from '@/shared/telemetry/log';
import { fakeAssetHub, fakeChainApis, fakePeople } from '@/testing/fakeChain';
import { alice, ALICE_42 } from '@/testing/fixtures';

const h = vi.hoisted(() => ({
  apis: null as ChainApis | null,
  connectionFails: false,
  submitClaim: vi.fn(),
  wasSpentBefore: vi.fn(),
  waitForGasTopUp: vi.fn(),
  keepGasReady: vi.fn(),
  /** Whether the host has purses. */
  hostHasPurses: true,
  /** How many accounts the host has created in the stash purse. */
  created: 0,
  /** The steps the mint journeys recorded, as `<journey id> <step>`. */
  steps: [] as string[],
  /** Whether the session can sign a claim, and the minter's listener for a change of it. */
  canSign: true,
  tellCanSign: (_canSign: boolean): void => {},
}));

vi.mock('@parity/product-sdk-host', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getNftPurseManager: async () => ({ createItems: async () => [`account-${String(++h.created)}`] }),
}));
vi.mock('@/entities/nfts/stashPurse', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  lookUpStashPurse: async () => (h.hostHasPurses ? { status: 'ready', id: 0 } : { status: 'hostWithoutPurses' }),
}));
// The host here names its accounts by plain names, so a public key is its own address.
vi.mock('@/shared/chain/ss58', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  addressOfPublicKey: (publicKey: string) => publicKey,
}));
vi.mock('@/shared/chain/client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getChainApis: async () => {
    if (h.connectionFails) throw new Error('the connection closed');
    return h.apis;
  },
}));
vi.mock('@/entities/player/identity', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getPlayerAddress: () => ALICE_42,
  recordsOwner: () => `a:${ALICE_42}|`,
}));
vi.mock('@/entities/credits/creditAccount', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  creditIdentity: async () => alice,
  creditSigner: async () => ({}),
  canMint: () => h.canSign,
  subscribeCanMint: (cb: (canSign: boolean) => void) => {
    h.tellCanSign = cb;
    cb(h.canSign);
    return () => {};
  },
}));
vi.mock('@/shared/host/embed', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isInContainer: true,
}));
vi.mock('@/entities/credits/gas', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  keepGasReady: (...args: unknown[]) => h.keepGasReady(...args),
  waitForGasTopUp: () => h.waitForGasTopUp(),
}));
vi.mock('@/entities/credits/claim', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  submitClaim: (...args: unknown[]) => h.submitClaim(...args),
  wasSpentBefore: (...args: unknown[]) => h.wasSpentBefore(...args),
}));
vi.mock('@/shared/telemetry/log', async (importOriginal) => {
  const actual = await importOriginal<{ journey: typeof journey }>();
  return {
    ...actual,
    journey: (...args: Parameters<typeof actual.journey>): JourneyHandle => {
      const handle = actual.journey(...args);
      return {
        id: handle.id,
        step: (name, ...rest) => {
          h.steps.push(`${handle.id} ${name}`);
          handle.step(name, ...rest);
        },
        done: (facts) => {
          h.steps.push(`${handle.id} done`);
          handle.done(facts);
        },
        fail: (kind, reason, facts) => {
          h.steps.push(`${handle.id} failed ${String(kind)}`);
          handle.fail(kind, reason, facts);
        },
      };
    },
  };
});

import { mintNftFromCredit, startDueMints } from './mint';

const A = 'aa'.repeat(32);
const B = 'bb'.repeat(32);

/** The parts of a claim the tests read, from `submitClaim(apis, claim, claimant, trace)`. */
const claimOf = (call: unknown[]) => {
  const claim = call[1] as { credit: string; awardBlock: number; collection: number; mintTo: string };
  return {
    mintTo: claim.mintTo,
    params: { credit: claim.credit, awardBlock: claim.awardBlock, collection: claim.collection },
    nonce: (call[2] as { nonce: { next(): Promise<number | undefined> } }).nonce,
  };
};

/** A claim that lands and mints instance 17680 into the account it was given. */
async function claimLands(...call: unknown[]) {
  return { ok: true, mintedTo: claimOf(call).mintTo, minted: { instance: '17680', collection: 2, item: 19 } };
}

/** The steps the journeys recorded, without their journey ids. */
const stepNames = () => h.steps.map((step) => step.slice(step.indexOf(' ') + 1));

beforeEach(() => {
  const { api: assetHub } = fakeAssetHub();
  h.apis = fakeChainApis(assetHub, fakePeople().api);
  h.connectionFails = false;
  h.hostHasPurses = true;
  h.created = 0;
  h.steps = [];
  h.submitClaim.mockReset().mockImplementation(claimLands);
  h.wasSpentBefore.mockReset().mockResolvedValue(false);
  h.waitForGasTopUp.mockReset().mockResolvedValue(undefined);
  h.keepGasReady.mockReset().mockResolvedValue(undefined);
  // Both credits wait on the grid with the proofs the credits read brought.
  collectiblesStore.getState().readCredits(
    recordsOwner(),
    [
      { hash: A, awardBlock: 11, claimable: true, leafIndex: 0, proof: ['0xsib'] },
      { hash: B, awardBlock: 11, claimable: true, leafIndex: 1, proof: ['0xsib'] },
    ],
    null,
  );
});

afterEach(() => {
  collectiblesStore.setState(EMPTY_KEPT);
  queryClient.clear();
});

describe('mintNftFromCredit', () => {
  it('mints an NFT from a credit into a new account of the stash purse', async () => {
    expect(await mintNftFromCredit({ credit: A, awardBlock: 11, collection: 2 })).toEqual({ ok: true });
    const claim = claimOf(h.submitClaim.mock.calls[0]!);
    expect(claim.mintTo).toBe('account-1');
    expect(claim.params).toEqual({ credit: `0x${A}`, awardBlock: 11, collection: 2 });
  });

  it('waits for a running gas top-up before it claims', async () => {
    let topUpEnds = (): void => {};
    h.waitForGasTopUp.mockReturnValue(new Promise<void>((resolve) => (topUpEnds = resolve)));
    const ended = mintNftFromCredit({ credit: A, awardBlock: 11, collection: 2 });
    await vi.waitFor(() => expect(h.waitForGasTopUp).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.submitClaim).not.toHaveBeenCalled();
    topUpEnds();
    await ended;
    expect(h.submitClaim).toHaveBeenCalledTimes(1);
  });

  it('runs a second mint once the first has ended, with a nonce read after it', async () => {
    let releaseFirst = (_result: unknown) => {};
    h.submitClaim.mockImplementationOnce(() => new Promise((resolve) => (releaseFirst = resolve)));
    const first = mintNftFromCredit({ credit: A, awardBlock: 11, collection: 2 });
    const second = mintNftFromCredit({ credit: B, awardBlock: 11, collection: 2 });
    await vi.waitFor(() => expect(h.submitClaim).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.submitClaim).toHaveBeenCalledTimes(1);
    releaseFirst({ ok: true, mintedTo: 'account-1' });
    await Promise.all([first, second]);
    const [firstLease, secondLease] = h.submitClaim.mock.calls.map((call) => claimOf(call).nonce);
    expect(h.submitClaim).toHaveBeenCalledTimes(2);
    expect(h.submitClaim.mock.calls.map((call) => claimOf(call).mintTo)).toEqual(['account-1', 'account-2']);
    expect(secondLease).not.toBe(firstLease);
  });

  it('signs with a nonce lease read from Asset Hub', async () => {
    await mintNftFromCredit({ credit: A, awardBlock: 11, collection: 2 });
    expect(await claimOf(h.submitClaim.mock.calls[0]!).nonce.next()).toBe(5);
  });

  it("fails with the claim's failure kind, never its detail", async () => {
    const detail = 'Module · NftClaims · CollectionNotRegistered';
    h.submitClaim.mockResolvedValue({ ok: false, error: detail, failure: { kind: 'stuck', detail } });
    expect(await mintNftFromCredit({ credit: A, awardBlock: 11, collection: 2 })).toEqual({
      ok: false,
      failure: 'stuck',
    });
  });

  it('counts a failed claim as minted when the chain shows the credit spent', async () => {
    const detail = 'the connection dropped';
    h.submitClaim.mockResolvedValue({ ok: false, error: detail, failure: { kind: 'transient', detail } });
    h.wasSpentBefore.mockResolvedValue(true);
    expect(await mintNftFromCredit({ credit: A, awardBlock: 11, collection: 2 })).toEqual({ ok: true });
  });

  it('fails as transient, on its journey too, when the mint throws on the way to the claim', async () => {
    h.connectionFails = true;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await mintNftFromCredit({ credit: A, awardBlock: 11, collection: 2 })).toEqual({
      ok: false,
      failure: 'transient',
    });
    expect(stepNames()).toEqual(['submitted', 'failed transient']);
    expect(h.submitClaim).not.toHaveBeenCalled();
  });

  it('fails as not allowed on a host without purses, so no mint follows', async () => {
    h.hostHasPurses = false;
    expect(await mintNftFromCredit({ credit: A, awardBlock: 11, collection: 2 })).toEqual({
      ok: false,
      failure: 'notAllowed',
    });
    expect(h.created).toBe(0);
    expect(h.submitClaim).not.toHaveBeenCalled();
  });

  it("records the mint's journey from its start to the claim, and ends it there", async () => {
    await mintNftFromCredit({ credit: A, awardBlock: 11, collection: 2 });
    expect(stepNames()).toEqual(['submitted', 'proof kept', 'account created', 'done']);
    expect(new Set(h.steps.map((step) => step.split(' ')[0])).size).toBe(1);
  });

  it("records a failed claim's kind on its credit's journey", async () => {
    const detail = 'the chain refused the proof';
    h.submitClaim.mockResolvedValue({ ok: false, error: detail, failure: { kind: 'stuck', detail } });
    await mintNftFromCredit({ credit: A, awardBlock: 11, collection: 2 });
    expect(stepNames()).toEqual(['submitted', 'proof kept', 'account created', 'failed stuck']);
  });

  it('creates no purse account for a credit whose proof cannot be read', async () => {
    collectiblesStore.setState(EMPTY_KEPT);
    expect((await mintNftFromCredit({ credit: A, awardBlock: 11, collection: 2 })).ok).toBe(false);
    expect(h.created).toBe(0);
    expect(h.submitClaim).not.toHaveBeenCalled();
  });

  it('moves the gas ahead again once a mint lands', async () => {
    await mintNftFromCredit({ credit: A, awardBlock: 11, collection: 2 });
    expect(h.keepGasReady).toHaveBeenCalledTimes(1);
    expect(h.keepGasReady.mock.calls[0]?.slice(0, 2)).toEqual([h.apis!.assetHub, ALICE_42]);
  });
});

describe('the mints the app starts by itself', () => {
  const DAY = 86_400;
  const ITEM: ResolvedCollectible = {
    url: 'https://gw.example/ipfs/bafypicture',
    name: 'Mocha',
    collectionIndex: 20,
    isRare: false,
    glow: '1 2 3',
    hasArt: true,
  };

  interface Reads {
    selectionsRead?: boolean;
    /** What each credit would mint in its collection. */
    item?: ResolvedCollectible | null;
    /** When the mint of every credit failed, if it did. */
    failedAt?: number;
  }

  /** The store as the reads leave it: each credit awarded `ages[hash]` days ago
   *  with 90 days to live, claimable, and going to collection 2. */
  function haveCredits(ages: Record<string, number>, { selectionsRead = true, item = ITEM, failedAt }: Reads = {}) {
    const now = Math.floor(Date.now() / 1000);
    const hashes = Object.keys(ages);
    const credits = hashes.map((hash, leafIndex) => ({
      hash,
      awardBlock: 11,
      claimable: true,
      leafIndex,
      proof: ['0xsib'],
      awardedAt: now - ages[hash]! * DAY,
      expiresAt: now + (90 - ages[hash]!) * DAY,
    }));
    const selected = new Map(hashes.map((hash) => [hash, { selectedCollectionId: '2' }]));
    let kept = onCreditsRead(EMPTY_KEPT, recordsOwner(), credits, selected);
    kept = onCollectionItemsRead(
      kept,
      hashes.map((hash) => ({ credit: hash, collectionId: '2', item, readAt: Date.now() })),
    );
    if (failedAt !== undefined) {
      const fail = (r: Collectible): Collectible => ({ ...r, mintFailure: 'transient', mintFailedAt: failedAt });
      const failed = Object.values(kept.records).map(fail);
      kept = { ...kept, records: Object.fromEntries(failed.map((r) => [r.id, r])) };
    }
    collectiblesStore.setState({ ...kept, selectionsRead });
  }

  const claimedCredits = () => h.submitClaim.mock.calls.map((call) => claimOf(call).params.credit);
  const recordOf = (hash: string) => collectiblesStore.getState().records[`c:${hash}`];
  const aMoment = () => new Promise((resolve) => setTimeout(resolve, 20));
  const fails = (kind: string) => ({ ok: false, error: kind, failure: { kind, detail: kind } });

  beforeAll(() => startDueMints());

  beforeEach(() => {
    h.canSign = true;
    collectiblesStore.setState({ ...EMPTY_KEPT, selectionsRead: false });
    // Each claim mints an instance of its own.
    h.submitClaim.mockImplementation(async (...call: unknown[]) => {
      const { mintTo } = claimOf(call);
      return { ok: true, mintedTo: mintTo, minted: { instance: mintTo, collection: 2, item: 19 } };
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('mints from a credit once half of its lifetime is gone, and leaves a younger one a credit', async () => {
    haveCredits({ [A]: 46, [B]: 44 });
    await vi.waitFor(() => expect(recordOf(A)?.type).toBe('nft'));
    await aMoment();
    expect(claimedCredits()).toEqual([`0x${A}`]);
    expect(h.submitClaim.mock.calls.map((call) => claimOf(call).params.collection)).toEqual([2]);
    expect(recordOf(B)?.type).toBe('credit');
  });

  it('mints from each due credit in turn', async () => {
    haveCredits({ [A]: 46, [B]: 50 });
    await vi.waitFor(() => expect(claimedCredits()).toEqual([`0x${A}`, `0x${B}`]));
    await vi.waitFor(() => expect([recordOf(A)?.type, recordOf(B)?.type]).toEqual(['nft', 'nft']));
  });

  it('starts nothing while the session cannot sign a claim, and mints once it can', async () => {
    h.canSign = false;
    haveCredits({ [A]: 46 });
    await aMoment();
    expect(h.submitClaim).not.toHaveBeenCalled();
    h.canSign = true;
    h.tellCanSign(true);
    await vi.waitFor(() => expect(claimedCredits()).toEqual([`0x${A}`]));
  });

  it('starts nothing until the stored selections are read in this session', async () => {
    haveCredits({ [A]: 46 }, { selectionsRead: false });
    await aMoment();
    expect(h.submitClaim).not.toHaveBeenCalled();
    collectiblesStore.setState({ selectionsRead: true });
    await vi.waitFor(() => expect(claimedCredits()).toEqual([`0x${A}`]));
  });

  it('starts nothing for a credit that would mint nothing in its collection', async () => {
    haveCredits({ [A]: 46 }, { item: null });
    await aMoment();
    expect(h.submitClaim).not.toHaveBeenCalled();
  });

  it('writes a failed mint on the record, and does not try that credit again in the session', async () => {
    vi.useFakeTimers();
    h.submitClaim.mockResolvedValue(fails('stuck'));
    haveCredits({ [A]: 46 });
    await vi.waitFor(() => expect(recordOf(A)?.mintFailure).toBe('stuck'));
    expect(recordOf(A)?.mintFailedAt).toBeGreaterThanOrEqual(SESSION_STARTED_AT);
    // Past the pause after the failure, the loop finds nothing left to mint, and
    // a fresh start does not try the credit again either.
    await vi.advanceTimersByTimeAsync(61_000);
    h.tellCanSign(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.submitClaim).toHaveBeenCalledTimes(1);
  });

  it('tries again a credit whose mint failed in an earlier session', async () => {
    haveCredits({ [A]: 46 }, { failedAt: SESSION_STARTED_AT - 1 });
    await vi.waitFor(() => expect(recordOf(A)?.type).toBe('nft'));
  });

  it('goes on to the next due credit 60 seconds after a mint that failed', async () => {
    vi.useFakeTimers();
    h.submitClaim.mockResolvedValueOnce(fails('transient'));
    haveCredits({ [A]: 46, [B]: 50 });
    await vi.advanceTimersByTimeAsync(59_000);
    expect(claimedCredits()).toEqual([`0x${A}`]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(claimedCredits()).toEqual([`0x${A}`, `0x${B}`]);
  });

  it('waits the same 60 seconds after a stuck mint, since its collection may be at fault', async () => {
    vi.useFakeTimers();
    h.submitClaim.mockResolvedValueOnce(fails('stuck'));
    haveCredits({ [A]: 46, [B]: 50 });
    await vi.advanceTimersByTimeAsync(59_000);
    expect(claimedCredits()).toEqual([`0x${A}`]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(claimedCredits()).toEqual([`0x${A}`, `0x${B}`]);
  });

  it('starts no further mint in the session after a failure that fails every mint', async () => {
    vi.useFakeTimers();
    h.submitClaim.mockResolvedValue(fails('fee'));
    haveCredits({ [A]: 46, [B]: 50 });
    await vi.advanceTimersByTimeAsync(180_000);
    expect(claimedCredits()).toEqual([`0x${A}`]);
    expect(recordOf(A)?.mintFailure).toBe('fee');
  });
});
