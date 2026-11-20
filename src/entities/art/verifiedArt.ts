// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// Nothing unverified reaches the screen: an <img> cannot check what it loads,
// so the app fetches a CID's bytes itself, checks them against the CID, and
// gives the UI a `blob:` URL. Verified bytes are cached for the session and kept
// on this device (artStore.ts); a mismatch is recorded, a fetch that returned nothing
// is not.

import { IPFS_GATEWAY } from '@/shared/chain/network';
import { loadVerifiedContent, verdictOfBytes } from '@/shared/host/content';

import { getArt, putArt, removeArt } from './artStore';

/** The CID in a gateway URL shaped `.../ipfs/<cid>`, or null for a URL with
 *  none, which cannot be verified. */
export function cidFromUrl(url: string): string | null {
  const m = /\/ipfs\/([a-z2-7]{20,})(?:[/?#]|$)/i.exec(url);
  return m ? m[1]! : null;
}

/** CID → verified blob URL (or null when it can't be verified).
 *  Also serves as the in-flight dedupe: concurrent callers await one fetch. */
const cache = new Map<string, Promise<string | null>>();

/** One fetch: the verified bytes as a blob URL, a final rejection (the bytes
 *  do not match the CID), or a transient failure worth asking again. */
interface Fetched {
  src: string | null;
  transient: boolean;
}

/** Checks of saved bytes (a synchronous hash over several MB) run one at a time,
 *  each in an idle moment, so they do not all land in the first frames. */
let verifyTurn: Promise<unknown> = Promise.resolve();
function pacedVerdict(cid: string, bytes: Uint8Array): Promise<'verified' | 'transient' | 'rejected'> {
  const turn = verifyTurn.then(idleMoment).then(() => verdictOfBytes(cid, bytes));
  verifyTurn = turn.catch(() => {});
  return turn;
}
const idleMoment = (): Promise<void> =>
  new Promise((resolve) => {
    const idle = (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void })
      .requestIdleCallback;
    if (idle) idle(() => resolve(), { timeout: 200 });
    else setTimeout(resolve, 0);
  });

async function fetchAndVerify(url: string, cid: string): Promise<Fetched> {
  // Bytes kept on this device are read first: offline, the picture is still here.
  const kept = await getArt(cid);
  if (kept) {
    const verdict = await pacedVerdict(cid, kept.bytes);
    if (verdict === 'verified') {
      return { src: URL.createObjectURL(new Blob([kept.bytes], { type: kept.type })), transient: false };
    }
    // Only a final verdict clears the row: on a transient one the offline copy
    // must stay.
    if (verdict === 'rejected') void removeArt(cid);
  }
  const got = await loadVerifiedContent(url, cid);
  if (got.verdict !== 'verified') return { src: null, transient: got.verdict === 'transient' };
  // Kept on this device (artStore.ts), so it needs no network for this picture again.
  void putArt(cid, got.bytes, got.type);
  return { src: URL.createObjectURL(new Blob([got.bytes], { type: got.type })), transient: false };
}

/** A `blob:` URL of the verified bytes behind the CID in `url`, fetched from
 *  this network's gateway or the host, never from the link's own site. Null when
 *  `url` carries no CID or the bytes don't match it. A fetch that returned nothing is
 *  asked again next call. */
export function loadVerifiedArt(url: string): Promise<string | null> {
  const cid = cidFromUrl(url);
  if (!cid) return Promise.resolve(null);
  const hit = cache.get(cid);
  if (hit) return hit;
  const pending = fetchAndVerify(`${IPFS_GATEWAY}/ipfs/${cid}`, cid).then((r) => {
    if (r.transient) cache.delete(cid);
    return r.src;
  });
  cache.set(cid, pending);
  return pending;
}
