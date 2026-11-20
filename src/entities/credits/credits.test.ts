// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// fetchClaims wraps the SDK's `getClaims`, so its tests fake that read. They
// cover which credits it keeps, what it watches for, and that a failed read
// rejects. fetchClaimProof reads the typed api and is tested against the fake
// People Chain.

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeAssetHub, fakeChainApis, fakePeople } from '@/testing/fakeChain';
import { alice, ALICE_42 } from '@/testing/fixtures';

const getClaims = vi.fn();
vi.mock('@parity/product-sdk-nfts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getClaims: (...args: unknown[]) => getClaims(...args),
}));

const { creditBlocksAt, creditStateAt, fetchClaims, fetchClaimProof, isDueForMint, isLeafClaimed } =
  await import('./credits');

const apis = fakeChainApis(fakeAssetHub().api, fakePeople().api);

const AT = {
  individuality: { blockHash: '0xfeed', blockNumber: 42 },
  assetHub: { blockHash: '0xbeef', blockNumber: 43 },
};

const claim = (
  hash: string | null,
  extra: Partial<{ awardBlock: number; awardedAt: number | null; state: string; leafIndex: number | null }> = {},
) => ({
  hash,
  awardBlock: extra.awardBlock ?? 10,
  awardedAt: extra.awardedAt ?? null,
  gameIndex: null,
  leafIndex: extra.leafIndex !== undefined ? extra.leafIndex : hash === null ? null : 0,
  proof: hash === null ? null : [],
  state: extra.state ?? 'earned',
});

const ok = (claims: unknown[]) => ({ ok: true, value: { at: AT, claims } });

beforeEach(() => getClaims.mockReset());

describe('isDueForMint', () => {
  const credit = { hash: 'aa', awardBlock: 10, claimable: true, awardedAt: 1_000, expiresAt: 1_000 + 7_776_000 };
  const HALF = (1_000 + 3_888_000) * 1000;

  it('is true from the moment half of the lifetime is gone', () => {
    expect(isDueForMint(credit, HALF - 1)).toBe(false);
    expect(isDueForMint(credit, HALF)).toBe(true);
  });

  it('is false for a credit with no tree time yet', () => {
    expect(isDueForMint({ hash: 'aa', awardBlock: 10, claimable: false }, HALF)).toBe(false);
  });
});

describe('fetchClaims', () => {
  it('keeps the credits not spent yet, dropping a spent one and one with no hash to show', async () => {
    getClaims.mockResolvedValueOnce(
      ok([
        claim('0xaa', { awardBlock: 10, awardedAt: 1000, state: 'claimable' }),
        claim('0xbb', { awardBlock: 10, awardedAt: 1000, state: 'claimed' }),
        claim('0xcc', { awardBlock: 11, state: 'earned' }),
        claim(null, { awardBlock: 9, state: 'unprovable' }), // pruned block: dropped
      ]),
    );
    const { credits } = await fetchClaims(apis, alice);
    expect(credits.map((credit) => [credit.hash, credit.claimable])).toEqual([
      ['aa', true],
      ['cc', false],
    ]);
  });

  it("gives a rooted credit the time it expires, from its tree's time and the chain's TreeTtl", async () => {
    getClaims.mockResolvedValueOnce(
      ok([
        claim('0xaa', { awardBlock: 10, awardedAt: 1000, state: 'claimable' }),
        claim('0xcc', { awardBlock: 11, state: 'earned' }),
      ]),
    );
    const { credits } = await fetchClaims(apis, alice);
    expect(credits.map((credit) => [credit.hash, credit.expiresAt])).toEqual([
      ['aa', 1000 + 7_776_000],
      ['cc', undefined],
    ]);
  });

  it('counts a credit whose block has lost its root as claimed, and keeps watching a fresh rootless one', async () => {
    const at = { ...AT, individuality: { blockHash: '0xfeed', blockNumber: 5000 } };
    getClaims.mockResolvedValueOnce({
      ok: true,
      value: {
        at,
        claims: [
          claim('0xdd', { awardBlock: 10, state: 'earned' }),
          claim('0xee', { awardBlock: 4990, state: 'earned' }),
        ],
      },
    });
    const { credits, watch } = await fetchClaims(apis, alice);
    expect(credits.map((credit) => credit.awardBlock)).toEqual([4990]);
    expect(watch.rootless).toEqual([4990]);
  });

  it('asks for an account or a person as the claimant it is given', async () => {
    getClaims.mockResolvedValue(ok([]));
    await fetchClaims(apis, alice);
    expect(getClaims.mock.calls[0]?.[1]).toMatchObject({
      claimant: { tag: 'Account', address: ALICE_42 },
    });
    await fetchClaims(apis, { tag: 'Person', alias: '0xabcd' });
    expect(getClaims.mock.calls[1]?.[1]).toMatchObject({
      claimant: { tag: 'Person', alias: '0xabcd' },
    });
  });

  it('reads both chains at the shown block, the People awards included', async () => {
    getClaims.mockResolvedValue(ok([]));
    await fetchClaims(apis, alice);
    expect(getClaims.mock.calls[0]?.[1]).toMatchObject({ at: 'best', individualityAt: 'best' });
  });

  it('marks a credit claimable, with its proof, only once its tree is on Asset Hub', async () => {
    getClaims.mockResolvedValueOnce(
      ok([
        claim('0xaa', { awardBlock: 10, awardedAt: 1000, state: 'claimable', leafIndex: 4 }),
        claim('0xbb', { awardBlock: 11, awardedAt: 1100, state: 'earned' }),
      ]),
    );
    const { credits } = await fetchClaims(apis, alice);
    expect(credits).toEqual([
      { hash: 'aa', awardBlock: 10, awardedAt: 1000, expiresAt: 7_777_000, claimable: true, leafIndex: 4, proof: [] },
      { hash: 'bb', awardBlock: 11, awardedAt: 1100, expiresAt: 7_777_100, claimable: false },
    ]);
  });

  it('rejects when the read fails, rather than surfacing a Result to the poll', async () => {
    const error = new Error('Storage entry NftCredits.NftClaimCreditBlocks does not exist');
    getClaims.mockResolvedValueOnce({ ok: false, error });
    await expect(fetchClaims(apis, alice)).rejects.toThrow(error);
  });

  it('rejects without a People Chain connection', async () => {
    const withoutPeople = fakeChainApis(fakeAssetHub().api, null);
    await expect(fetchClaims(withoutPeople, alice)).rejects.toThrow(/People Chain/);
    expect(getClaims).not.toHaveBeenCalled();
  });
});

describe('what the credits wait for', () => {
  const H = (n: number) => '0x' + n.toString(16).padStart(64, '0');

  beforeEach(() => {
    getClaims.mockReset();
  });

  it('names the blocks awaiting a root or a tree, and the leaves not claimed yet', async () => {
    getClaims.mockResolvedValue(
      ok([
        claim(H(1), { awardBlock: 12 }), // rootless
        claim(null, { awardBlock: 13 }), // a block still to come
        claim(H(2), { awardBlock: 10, awardedAt: 100 }), // rooted, its tree on the way
        claim(H(3), { awardBlock: 11, awardedAt: 200, state: 'claimable', leafIndex: 3 }),
        claim(H(4), { awardBlock: 11, awardedAt: 200, state: 'claimed', leafIndex: 4 }),
        claim(H(5), { awardBlock: 11, awardedAt: 200, state: 'claimable', leafIndex: 5 }),
        claim(null, { awardBlock: 9, awardedAt: 50, state: 'unprovable' }),
      ]),
    );
    const { watch } = await fetchClaims(apis, alice);
    expect(watch).toEqual({ rootless: [12, 13], awaitingTree: [10], unclaimed: [{ block: 11, leaves: [3, 5] }] });
  });

  it('passes on the People Chain side as it stood at the block the read took', async () => {
    const { api: people, spies } = fakePeople({ creditBlocks: [10, 12] });
    const both = fakeChainApis(fakeAssetHub().api, people);
    getClaims.mockResolvedValue(ok([claim(H(1), { awardBlock: 12 })]));
    const { peopleSignature } = await fetchClaims(both, alice);
    expect(peopleSignature).toBe(await creditBlocksAt(people, alice, [12], '0xfeed'));
    expect(spies.creditBlocks).toHaveBeenCalledWith({ type: 'Account', value: ALICE_42 }, { at: '0xfeed' });
  });

  it('goes without the People Chain side when that block cannot be read again', async () => {
    const { api: people, spies } = fakePeople({ creditBlocks: [12] });
    spies.creditBlocks.mockRejectedValueOnce(new Error('block not pinned'));
    getClaims.mockResolvedValue(ok([claim(H(1), { awardBlock: 12 })]));
    const read = await fetchClaims(fakeChainApis(fakeAssetHub().api, people), alice);
    expect(read.peopleSignature).toBeUndefined();
    expect(read.credits).toHaveLength(1);
  });

  it('sees a new award and a root arriving on the People Chain', async () => {
    const before = await creditBlocksAt(fakePeople({ creditBlocks: [10] }).api, alice, [10], '0x1');
    const awarded = await creditBlocksAt(fakePeople({ creditBlocks: [10, 12] }).api, alice, [10], '0x2');
    const rooted = await creditBlocksAt(
      fakePeople({ creditBlocks: [10], roots: [[10, { root: '0xr', leaf_count: 1, timestamp: 1 }]] }).api,
      alice,
      [10],
      '0x3',
    );
    expect(awarded).not.toBe(before);
    expect(rooted).not.toBe(before);
  });

  it("returns '' on Asset Hub until a tree arrives or one of the player's leaves is claimed", async () => {
    const watch = { rootless: [], awaitingTree: [10], unclaimed: [{ block: 11, leaves: [3, 5] }] };
    // Bit 4 is another player's leaf: their claim is no change for this player.
    const quiet = fakeAssetHub({ claimedLeaves: new Map([[11, Uint8Array.of(0b0001_0000)]]) });
    expect(await creditStateAt(quiet.api, watch, '0xb10c')).toBe('');
    expect(quiet.spies.creditTrees).toHaveBeenCalledWith([[10]], { at: '0xb10c' });
    const tree = fakeAssetHub({ creditTrees: new Map([[10, { root: '0xr' }]]) });
    expect(await creditStateAt(tree.api, watch, '0xb10d')).toBe('tree 10');
    const claimed = fakeAssetHub({ claimedLeaves: new Map([[11, Uint8Array.of(0b0010_0000)]]) });
    expect(await creditStateAt(claimed.api, watch, '0xb10e')).toBe('leaf 11:5');
  });

  it('reads nothing on Asset Hub when it waits for nothing', async () => {
    const { api, spies } = fakeAssetHub();
    expect(await creditStateAt(api, { rootless: [12], awaitingTree: [], unclaimed: [] }, '0xb10c')).toBeNull();
    expect(spies.creditTrees).not.toHaveBeenCalled();
    expect(spies.claimedLeaves).not.toHaveBeenCalled();
  });
});

describe('fetchClaimProof', () => {
  it('matches by credit hash (0x/case-insensitive) and returns leafIndex + proof', async () => {
    const { api } = fakePeople({
      proofs: new Map([
        [
          10,
          {
            success: true,
            value: [{ credit: '0xCAFE', leaf: '0x', leaf_index: 3, proof: ['0xsib'] }],
          },
        ],
      ]),
    });
    const proof = await fetchClaimProof(api, alice, 10, 'cafe');
    expect(proof).toEqual({ credit: '0xCAFE', leafIndex: 3, proof: ['0xsib'] });
  });

  it('returns null when the block holds no such credit', async () => {
    const { api } = fakePeople({
      proofs: new Map([[10, { success: true, value: [{ credit: '0xCAFE', leaf: '0x', leaf_index: 3, proof: [] }] }]]),
    });
    expect(await fetchClaimProof(api, alice, 10, 'beef')).toBeNull();
  });

  it('returns null when proofs are unavailable (pruned/errored)', async () => {
    const { api } = fakePeople({
      proofs: new Map([[10, { success: false, value: { type: 'AwardsPruned' } }]]),
    });
    expect(await fetchClaimProof(api, alice, 10, 'cafe')).toBeNull();
  });
});

describe('isLeafClaimed', () => {
  it("reads from the tree's bitmap, read at the newest block", async () => {
    const { api, spies } = fakeAssetHub({
      claimedLeaves: new Map([[7, Uint8Array.of(0b0000_1000)]]),
    });
    expect(await isLeafClaimed(api, 7, 3)).toBe(true);
    expect(await isLeafClaimed(api, 7, 2)).toBe(false);
    expect(spies.claimedLeaves.mock.calls[0]).toEqual([[[7]], { at: 'best' }]);
  });

  it('reads the leaf bit least significant bit first', async () => {
    const { api } = fakeAssetHub({
      claimedLeaves: new Map([[7, Uint8Array.of(0b0000_0101, 0b1000_0000)]]), // leaves 0, 2 and 15
    });
    const answers = await Promise.all([0, 1, 2, 3, 15].map((leaf) => isLeafClaimed(api, 7, leaf)));
    expect(answers).toEqual([true, false, true, false, true]);
  });

  it('treats a leaf past the end of the bitmap, or a tree with no bitmap yet, as unclaimed', async () => {
    const { api } = fakeAssetHub({ claimedLeaves: new Map([[7, Uint8Array.of(0xff)]]) });
    expect(await isLeafClaimed(api, 7, 8)).toBe(false);
    expect(await isLeafClaimed(api, 8, 0)).toBe(false);
  });

  it('returns null when the bitmap cannot be read, so the caller decides', async () => {
    const { api, spies } = fakeAssetHub();
    spies.claimedLeaves.mockRejectedValueOnce(new Error('socket closed'));
    expect(await isLeafClaimed(api, 7, 0)).toBeNull();
  });
});
