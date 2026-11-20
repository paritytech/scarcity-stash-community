// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// The chain connections of this session. Inside a host every connection is the
// host's and the page opens no socket; anywhere else there is none. People is
// optional: without it the grid shows NFTs only, and every read that needs it
// asks the host again. A chain whose finalized blocks stop coming is rebuilt on
// its own, so a healthy connection keeps its place.

import { createChainClient } from '@parity/product-sdk-chain-client';
import { ChainNotSupportedError, type HexString, isChainSupported } from '@parity/product-sdk-host';
import type { paseoAssetHub, paseoPeople } from '@polkadot-api/descriptors';
import type { PolkadotClient, TypedApi } from 'polkadot-api';

import { isInContainer } from '@/shared/host/embed';
import { withDeadline } from '@/shared/lib/deadline';

import { ASSET_HUB, PEOPLE } from './network';

export type AssetHubApi = TypedApi<typeof paseoAssetHub>;
export type PeopleApi = TypedApi<typeof paseoPeople>;

/** The session's typed apis. `people` is null when that chain is
 *  unavailable (the grid then shows NFTs only). */
export interface ChainApis {
  assetHub: AssetHubApi;
  people: PeopleApi | null;
  /** The raw clients behind the typed apis, null exactly when they are. Only a
   *  raw client can pin a block, so a whole read uses one chain state. */
  raw: { assetHub: PolkadotClient; people: PolkadotClient | null };
}

export type ChainName = 'assetHub' | 'people';

interface ContainerSession {
  apis: ChainApis;
  /** Asks the host for People while `apis.people` is null, on every read that
   *  needs it, so a host that gains the chain is picked up. */
  refreshPeople: () => Promise<void>;
  /** Replace one chain's client, in place in `apis`, leaving the other alone. */
  rebuild: (chain: ChainName) => Promise<void>;
}

// How long opening the connections, or asking for People, may take before the
// next read starts a new attempt.
const OPEN_MS = 20_000;
const PROBE_MS = 15_000;

/** How long a chain may go without a new finalized block and still count as live. */
const LIVE_MS = 60_000;
const lastFinalized: Record<ChainName, number> = { assetHub: 0, people: 0 };
const liveness = new Map<ChainName, { raw: PolkadotClient; unsubscribe: () => void }>();

/** Follows `raw`'s finalized blocks as `chain`'s liveness. Null stops it. */
function track(chain: ChainName, raw: PolkadotClient | null): void {
  const current = liveness.get(chain);
  if (current?.raw === raw) return;
  current?.unsubscribe();
  liveness.delete(chain);
  lastFinalized[chain] = 0;
  const blocks = (raw as Partial<PolkadotClient> | null)?.finalizedBlock$;
  if (!raw || !blocks) return;
  const subscription = blocks.subscribe({
    next: () => {
      lastFinalized[chain] = Date.now();
    },
    error: () => {
      // A client that is replaced or destroyed ends its stream; it stops counting.
    },
  });
  liveness.set(chain, { raw, unsubscribe: () => subscription.unsubscribe() });
}

/** Whether `chain`'s client has seen a new finalized block lately. A client
 *  still waiting for its first one is not live. */
export function isChainLive(chain: ChainName, now = Date.now()): boolean {
  return now - lastFinalized[chain] < LIVE_MS;
}

// One session at a time; a failed or stalled open drops it, so the next read
// opens anew.
let containerSession: Promise<ContainerSession> | null = null;

/** Asked before building a client. `isChainSupported` returns a failure as
 *  `{ ok: false }`; this throws it. */
async function hostServes(genesis: HexString): Promise<boolean> {
  const answer = await isChainSupported(genesis);
  if (!answer.ok) throw answer.error;
  return answer.value;
}

function safeDestroy(client: { destroy: () => void }): void {
  try {
    client.destroy();
  } catch {
    // already down
  }
}

// The SDK keeps one client per chain until that client is destroyed: a second
// call gives the same client back.
const openAssetHubClient = () => createChainClient({ chains: { assetHub: ASSET_HUB } });

/** The parts of a container session that change while it lives. */
interface SessionState {
  apis: ChainApis;
  assetHubClient: Awaited<ReturnType<typeof openAssetHubClient>>;
  peopleClient: { destroy: () => void } | null;
  warnedMissing: boolean;
  probing: Promise<void> | null;
}

// The chains are separate clients: a client fixes which chains it serves when
// made, so asking for People again needs a new one, leaving Asset Hub alone.
async function openContainerSession(): Promise<ContainerSession> {
  // A host without Asset Hub fails the session; the poll retries with backoff.
  const assetHubGenesis = ASSET_HUB.genesis as HexString;
  if (!(await hostServes(assetHubGenesis))) {
    console.warn('[chain] host does not serve Asset Hub; retrying');
    throw new ChainNotSupportedError(assetHubGenesis);
  }
  const assetHubClient = await openAssetHubClient();
  const s: SessionState = {
    apis: {
      assetHub: assetHubClient.assetHub,
      people: null,
      raw: { assetHub: assetHubClient.raw.assetHub, people: null },
    },
    assetHubClient,
    peopleClient: null,
    warnedMissing: false,
    probing: null,
  };
  track('assetHub', assetHubClient.raw.assetHub);
  return {
    apis: s.apis,
    refreshPeople: () => refreshPeople(s),
    rebuild: async (chain) => {
      if (chain === 'people') dropPeople(s);
      else await rebuildAssetHub(s);
    },
  };
}

/** Asks the host for the People Chain while the session has none, one probe
 *  at a time, given up after PROBE_MS. */
function refreshPeople(s: SessionState): Promise<void> {
  if (s.apis.people) return Promise.resolve();
  s.probing ??= withDeadline(probePeople(s), PROBE_MS, 'asking for the People Chain').finally(() => {
    s.probing = null;
  });
  return s.probing;
}

function warnMissingPeople(s: SessionState): void {
  if (s.warnedMissing) return;
  s.warnedMissing = true;
  console.warn(
    '[chain] host does not serve the People Chain; the grid shows NFTs only (asked again on each credits read)',
  );
}

async function probePeople(s: SessionState): Promise<void> {
  let served: boolean;
  try {
    served = await hostServes(PEOPLE.genesis as HexString);
  } catch {
    return; // an unreachable host must not kill the Asset Hub session
  }
  if (!served) {
    warnMissingPeople(s);
    return;
  }
  const client = await createChainClient({ chains: { people: PEOPLE } });
  let people: PeopleApi;
  try {
    people = client.people;
  } catch (err) {
    // Credits are optional, so a rejection after the probe degrades, not fails.
    if (!(err instanceof ChainNotSupportedError)) throw err;
    safeDestroy(client);
    warnMissingPeople(s);
    return;
  }
  // An earlier probe that outlived its deadline got this same client and may have installed it.
  if (s.apis.people) return;
  s.peopleClient = client;
  s.apis.people = people;
  s.apis.raw.people = client.raw.people;
  track('people', client.raw.people);
  if (s.warnedMissing) console.warn('[chain] the host now serves the People Chain; credits resume');
}

/** Drops the People Chain's client: the next read's refreshPeople builds a fresh one. */
function dropPeople(s: SessionState): void {
  if (s.peopleClient) safeDestroy(s.peopleClient);
  s.peopleClient = null;
  s.apis.people = null;
  s.apis.raw.people = null;
  track('people', null);
}

/** Replaces the Asset Hub client in place. The stopped one is closed first,
 *  because the SDK gives the same client back while it lives. */
async function rebuildAssetHub(s: SessionState): Promise<void> {
  safeDestroy(s.assetHubClient);
  s.assetHubClient = await openAssetHubClient();
  s.apis.assetHub = s.assetHubClient.assetHub;
  s.apis.raw.assetHub = s.assetHubClient.raw.assetHub;
  track('assetHub', s.apis.raw.assetHub);
}

/** This session's connections, or null outside a host. With `waitForPeople:
 *  false` the result does not wait for the People probe. */
export function getChainApis(opts: { waitForPeople?: boolean } = {}): Promise<ChainApis | null> {
  if (isInContainer) {
    if (!containerSession) {
      const session = withDeadline(openContainerSession(), OPEN_MS, 'opening the chain connection');
      containerSession = session;
      // A failed or stalled handshake must not poison every later read.
      session.catch(() => {
        if (containerSession === session) containerSession = null;
      });
    }
    // Every read gives the People Chain another chance (no-op once
    // connected); a hard probe failure surfaces as a failed read.
    return containerSession.then(async (s) => {
      if (opts.waitForPeople === false) void s.refreshPeople().catch(() => {});
      else await s.refreshPeople();
      return s.apis;
    });
  }
  return Promise.resolve(null);
}

/** Replace one chain's client when it has stopped advancing. No-op without a session. */
export async function rebuildChain(chain: ChainName): Promise<void> {
  const session = containerSession;
  if (!session) return;
  const open = await session.catch(() => null);
  await open?.rebuild(chain);
}
