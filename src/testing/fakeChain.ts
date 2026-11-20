// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// A fake papi client for unit tests of the read path: each method a `vi.fn()`
// over plain fixtures, so a test checks both the decoded result and the round
// trips. Everything is cast `as unknown as …Api`, since a fake implements only
// what the code under test touches.

import { vi } from 'vitest';

import type { AssetHubApi, ChainApis, PeopleApi } from '@/shared/chain/client';

/** UTF-8 bytes of a string: a metadata key ("hash"/"name"/"image") or a text
 *  value. */
export function text(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** Raw bytes of a 0x-hex string: e.g. a 32-byte identity hash whose
 *  `Binary.toHex(...)` the read path echoes back. */
export function bytesFromHex(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** One tier's pairs from a `{ key: valueBytes }` record, keys UTF-8 encoded. */
function tier(pairs?: Record<string, Uint8Array>): [Uint8Array, Uint8Array][] {
  return Object.entries(pairs ?? {}).map(([k, v]) => [text(k), v]);
}

/** A `metadata_batch` layers fixture: the three tiers the runtime resolves
 *  (instance > item > collection). Pass each tier as `{ key: bytes }`. */
export function metadataLayers(tiers: {
  instance?: Record<string, Uint8Array>;
  item?: Record<string, Uint8Array>;
  collection?: Record<string, Uint8Array>;
}): unknown {
  return {
    instance: tier(tiers.instance),
    item: tier(tiers.item),
    collection: tier(tiers.collection),
  };
}

/** A `NftsByOwner` value fixture: the fields the read path reads. */
export function nft(opts: {
  instance: bigint;
  mintedAt?: bigint;
  /** Defaults to the mint time, as the chain has it until the first move. */
  lastMoved?: bigint;
  stateNonce?: bigint;
  collection?: number;
  item?: number;
}): unknown {
  return {
    instance: opts.instance,
    collection: opts.collection ?? 0,
    item: opts.item ?? 0,
    minted_at: opts.mintedAt ?? 0n,
    last_moved: opts.lastMoved ?? opts.mintedAt ?? 0n,
    state_nonce: opts.stateNonce ?? 0n,
  };
}

export interface FakeAssetHubData {
  /** address -> the NFT that purse holds (absent = empty purse). */
  nftsByOwner?: Map<string, unknown>;
  /** instance id (as string) -> its metadata layers (absent = empty layers). */
  metadataByInstance?: Map<string, unknown>;
  /** `${collection}:${item}` -> its metadata layers (for Item queries). */
  metadataByItem?: Map<string, unknown>;
  /** `${collection}:${item}` -> its `ItemDefs` record. Absent falls back to a
   *  transferable definition of one. */
  itemDefs?: Map<
    string,
    { supply: number; live_supply: number; transferability: { type: 'Transferable' | 'Soulbound' } }
  >;
  /** Instance ids (as strings) `metadata_batch` must not resolve, although a
   *  purse holds them: the straddle between the holdings read and the batch. */
  unresolved?: Set<string>;
  /** award block -> tree info (absent/undefined = root not arrived). */
  creditTrees?: Map<number, unknown>;
  /** tree block -> its `ClaimedLeaves` bitmap (bit leaf_index, LSB first). */
  claimedLeaves?: Map<number, Uint8Array>;
  /** collection id -> the `preview_mints` outcome for that (credit, collection). */
  previewByCollection?: Map<number, unknown>;
  /** when set, `preview_mints` rejects the whole batch: the call rejects. */
  previewRefusal?: { type: string };
  /** when set, `metadata_batch` rejects every chunk: the call rejects, the
   *  oversized/unsupported path the read functions surface as a throw. */
  metadataRefusal?: { type: string };
  /** How the chain treats each claim in turn; claims past the list land. */
  claimOutcomes?: ({ ok: boolean; dispatchError?: unknown; events?: unknown[] } | { refuse: string })[];
  /** The claimant's nonce, as `AccountNonceApi.account_nonce` returns it. */
  nonce?: number;
}

const EMPTY_LAYERS = metadataLayers({});

/** The most queries Asset Hub Next serves in one call; more is a rejected
 *  call (measured: 32 previews, 128 layers). */
const PREVIEW_MINTS_MAX = 32;
const METADATA_BATCH_MAX = 128;
const refused = (what: string, reason: string): never => {
  throw new Error(`${what} refused the batch: ${reason}`);
};
const DEFAULT_DEF = { supply: 1, live_supply: 1, transferability: { type: 'Transferable' } };

/** A fake `AssetHubApi` backed by the given stores, every method a spy. */
export function fakeAssetHub(data: FakeAssetHubData = {}): {
  api: AssetHubApi;
  spies: {
    nftsByOwner: ReturnType<typeof vi.fn>;
    metadataBatch: ReturnType<typeof vi.fn>;
    itemDefs: ReturnType<typeof vi.fn>;
    creditTrees: ReturnType<typeof vi.fn>;
    claimedLeaves: ReturnType<typeof vi.fn>;
    previewMints: ReturnType<typeof vi.fn>;
    claimTx: ReturnType<typeof vi.fn>;
    accountNonce: ReturnType<typeof vi.fn>;
    /** The options each claim submission carried, in order. */
    submitOptions: unknown[];
  };
} {
  const nfts = data.nftsByOwner ?? new Map<string, unknown>();
  const metaInstance = data.metadataByInstance ?? new Map<string, unknown>();
  const metaItem = data.metadataByItem ?? new Map<string, unknown>();
  const trees = data.creditTrees ?? new Map<number, unknown>();
  const claimed = data.claimedLeaves ?? new Map<number, Uint8Array>();
  const preview = data.previewByCollection ?? new Map<number, unknown>();

  const nftsByOwner = vi.fn(async (keys: [string][]) => keys.map(([addr]) => nfts.get(addr)));
  /** The purse holding `instance`, so an Instance query resolves to the
   *  collection and item the purse's NFT value names, as the runtime does. */
  const holderOf = (instance: unknown): { collection: number; item: number } | undefined => {
    if (data.unresolved?.has(String(instance))) return undefined;
    for (const value of nfts.values()) {
      const held = value as { instance: bigint; collection: number; item: number };
      if (held.instance === instance) return { collection: held.collection, item: held.item };
    }
    return undefined;
  };
  // Resolves each query against the tier it targets: Instance or Item (the
  // latter keyed `${collection}:${item}`). Absent → empty layers. An Instance
  // nobody holds has no `resolved`, which the SDK reports as NotFound.
  const metadataBatch = vi.fn(async (queries: { type: string; value: unknown }[]) => {
    if (data.metadataRefusal) refused('metadata_batch', data.metadataRefusal.type);
    if (queries.length > METADATA_BATCH_MAX) refused('metadata_batch', `TooLarge (${METADATA_BATCH_MAX})`);
    return queries.map((q) => {
      if (q.type === 'Instance') {
        const layers = (metaInstance.get(String(q.value)) ?? EMPTY_LAYERS) as object;
        const target = holderOf(q.value);
        return target ? { ...layers, resolved: { type: 'Instance', value: { instance: q.value, ...target } } } : layers;
      }
      if (q.type === 'Item') {
        const { collection, item } = q.value as { collection: number; item: number };
        return metaItem.get(`${collection}:${item}`) ?? EMPTY_LAYERS;
      }
      return EMPTY_LAYERS;
    });
  });
  const itemDefs = vi.fn(async (keys: [number, number][]) =>
    keys.map(([collection, item]) => data.itemDefs?.get(`${collection}:${item}`) ?? DEFAULT_DEF),
  );
  const creditTrees = vi.fn(async (keys: [number][]) => keys.map(([b]) => trees.get(b)));
  // Positional, like the chain's getValues: a tree with nothing claimed reads
  // back the empty bitmap, the storage item's default.
  const claimedLeaves = vi.fn(async (keys: [number][]) => keys.map(([b]) => claimed.get(b) ?? new Uint8Array()));
  // Echoes an outcome per query positionally (queries are one credit ×
  // collections), so previewMints' index→collection alignment is exercised.
  const previewMints = vi.fn(async (queries: { credit: string; collection: number }[]) => {
    if (data.previewRefusal) refused('preview_mints', data.previewRefusal.type);
    if (queries.length > PREVIEW_MINTS_MAX) refused('preview_mints', `TooLarge (${PREVIEW_MINTS_MAX})`);
    return queries.map((q) => preview.get(q.collection) ?? { type: 'Fails', value: { reason: { type: 'Unknown' } } });
  });
  // Tx builder: records the call args (what the write flow assembled) and
  // returns a watchable that settles in-block ok, so watchSubmission resolves.
  const outcomes = [...(data.claimOutcomes ?? [])];
  const submitOptions: unknown[] = [];
  const claimTx = vi.fn((_args: unknown) => ({
    // A claim the fake chain charges nothing for: no gas top-up in these tests.
    getEstimatedFees: async () => 0n,
    createSubmitAndWatch: (_signer: unknown, options?: unknown) => ({
      subscribe: (obs: { next: (e: unknown) => void; error: (e: unknown) => void }) => {
        submitOptions.push(options);
        const outcome = outcomes.shift() ?? { ok: true };
        // A rejection is the pool's, before inclusion: the stream errors. An
        // outcome is in a block, which the event names as the real one does.
        const block = { hash: `0xb10c${submitOptions.length}`, number: 100 + submitOptions.length };
        queueMicrotask(() =>
          'refuse' in outcome
            ? obs.error(new Error(outcome.refuse))
            : obs.next({ type: 'inBestBlock', block, ...outcome }),
        );
        return { unsubscribe: () => {} };
      },
    }),
  }));

  const accountNonce = vi.fn(async (_who: string) => data.nonce ?? 5);

  const api = {
    // Ninety days, as on both networks.
    constants: { NftClaims: { TreeTtl: async () => 7_776_000n } },
    query: {
      Scarcity: {
        NftsByOwner: { getValues: nftsByOwner },
        ItemDefs: { getValues: itemDefs },
      },
      NftClaims: {
        CreditTrees: { getValues: creditTrees },
        ClaimedLeaves: { getValues: claimedLeaves },
      },
    },
    apis: {
      ScarcityApi: { metadata_batch: metadataBatch },
      NftClaimsApi: { preview_mints: previewMints },
      AccountNonceApi: { account_nonce: accountNonce },
    },
    tx: { NftClaims: { claim: claimTx } },
  } as unknown as AssetHubApi;

  return {
    api,
    spies: {
      nftsByOwner,
      metadataBatch,
      itemDefs,
      creditTrees,
      claimedLeaves,
      previewMints,
      claimTx,
      accountNonce,
      submitOptions,
    },
  };
}

export interface FakePeopleData {
  /** the claimant's tree blocks. */
  creditBlocks?: number[];
  /** `nft_claim_credit_roots` result: [block, { root, leaf_count, timestamp }]. */
  roots?: [number, { root: string; leaf_count: number; timestamp: number }][];
  /** tree block -> the block's awards (one chunk), for a rootless buffer. */
  awards?: Map<number, { claimant: { type: string; value: unknown }; credit: string }[]>;
  /** tree block -> `nft_claim_credit_proofs` result (success or failure). */
  proofs?: Map<number, { success: boolean; value: unknown }>;
}

/** A fake `PeopleApi` backed by the given stores, every method a spy. */
export function fakePeople(data: FakePeopleData = {}): {
  api: PeopleApi;
  spies: {
    creditBlocks: ReturnType<typeof vi.fn>;
    creditRoots: ReturnType<typeof vi.fn>;
    roots: ReturnType<typeof vi.fn>;
    awards: ReturnType<typeof vi.fn>;
    proofs: ReturnType<typeof vi.fn>;
  };
} {
  const awards = data.awards ?? new Map<number, { claimant: { type: string; value: unknown }; credit: string }[]>();
  const proofs = data.proofs ?? new Map<number, { success: boolean; value: unknown }>();

  const creditBlocks = vi.fn(async () => data.creditBlocks ?? []);
  // The `NftClaimCreditRoots` entries behind `roots`, positional like the
  // chain's getValues: a block with no root yet reads back undefined.
  const rootOf = new Map(data.roots ?? []);
  const creditRoots = vi.fn(async (keys: [number][]) => keys.map(([block]) => rootOf.get(block)));
  const roots = vi.fn(async () => data.roots ?? []);
  // Positional chunk read, as getClaims pulls it; the fake keeps one chunk
  // (index 0) per block, every other index reads back empty.
  const awardsFn = vi.fn(async (keys: [number, number][]) =>
    keys.map(([block, chunk]) => (chunk === 0 ? (awards.get(block) ?? []) : [])),
  );
  const proofsFn = vi.fn(async (block: number) => proofs.get(block) ?? { success: true, value: [] });

  const api = {
    query: {
      NftCredits: {
        NftClaimCreditBlocks: { getValue: creditBlocks },
        NftClaimCreditAwards: { getValues: awardsFn },
        NftClaimCreditRoots: { getValues: creditRoots },
      },
    },
    apis: {
      NftCreditsApi: {
        nft_claim_credit_roots: roots,
        nft_claim_credit_proofs: proofsFn,
      },
    },
  } as unknown as PeopleApi;

  return { api, spies: { creditBlocks, creditRoots, roots, awards: awardsFn, proofs: proofsFn } };
}

/** A raw client stand-in with the two pins the SDK reads take; `getBestBlocks`
 *  lists newest first, as PAPI does. */
export function fakeRawClient(): unknown {
  return {
    getFinalizedBlock: vi.fn(async () => ({ hash: '0xf1a1', number: 41 })),
    getBestBlocks: vi.fn(async () => [
      { hash: '0xbe57', number: 43, parent: '0xbe56' },
      { hash: '0xf1a1', number: 41, parent: '0xf1a0' },
    ]),
  };
}

/** The fake apis as a `ChainApis` session, raw clients included, for code
 *  (the SDK-backed reads) that takes the whole connection. */
export function fakeChainApis(assetHub: AssetHubApi, people: PeopleApi | null): ChainApis {
  return {
    assetHub,
    people,
    raw: { assetHub: fakeRawClient(), people: people ? fakeRawClient() : null },
  } as unknown as ChainApis;
}

/** A fake Asset Hub with its spies, and the `ChainApis` session around it. */
export function fakeAssetHubSession(data: FakeAssetHubData = {}) {
  const { api, spies } = fakeAssetHub(data);
  return { api, apis: fakeChainApis(api, null), spies };
}

/** A `Mints` outcome: the credit would mint `item`, selected `via`. */
export function mintsOutcome(item: number, via: 'random' | 'contract' = 'random'): unknown {
  return {
    type: 'Mints',
    value: { item, via: { type: via === 'contract' ? 'Contract' : 'Random' } },
  };
}

/** A `Fails` outcome carrying a reason variant tag. */
export function failsOutcome(reason: string): unknown {
  return { type: 'Fails', value: { reason: { type: reason } } };
}
