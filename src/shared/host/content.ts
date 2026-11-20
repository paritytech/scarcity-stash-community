// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// The bytes behind a content address. The host's preimage lookup and the
// network's Bulletin IPFS gateway are asked together and the first bytes win;
// `loadVerifiedContent` also checks them against the CID.

import { getPreimageManager, requestPermission } from '@parity/product-sdk-host';
import { artworkAddress, getVerifiedArtwork, preimageSource } from '@parity/product-sdk-nfts';

import { imageRefOfCid } from '@/shared/lib/cid';

export interface ContentBytes {
  bytes: Uint8Array<ArrayBuffer>;
  /** The gateway's content type, or one read off the bytes for a host lookup. */
  type: string;
}

// How long to wait on each source. The host may have to fetch the preimage
// from the network for the app; a gateway that has not returned in twelve
// seconds is treated as down for this attempt.
const HOST_LOOKUP_MS = 25_000;
const GATEWAY_MS = 12_000;

/** The files a host lookup can bring, by their first bytes: each part is
 *  bytes at an offset, and a file shorter than `minLength` matches none. */
const SIGNATURES: readonly { type: string; minLength: number; parts: { at: number; bytes: number[] }[] }[] = [
  // "RIFF" at 0 and "WEBP" at 8.
  {
    type: 'image/webp',
    minLength: 13,
    parts: [
      { at: 0, bytes: [0x52, 0x49, 0x46, 0x46] },
      { at: 8, bytes: [0x57, 0x45, 0x42, 0x50] },
    ],
  },
  { type: 'image/png', minLength: 5, parts: [{ at: 0, bytes: [0x89, 0x50, 0x4e, 0x47] }] },
  { type: 'image/jpeg', minLength: 3, parts: [{ at: 0, bytes: [0xff, 0xd8] }] },
];

/** The whitespace a JSON text may start with. */
const JSON_SPACE = new Set([0x20, 0x0a, 0x0d, 0x09]);

const hasBytesAt = (b: Uint8Array, at: number, bytes: readonly number[]): boolean =>
  bytes.every((byte, i) => b[at + i] === byte);

/** A content type from the first bytes, for the host path which carries none. */
export function sniffType(b: Uint8Array): string {
  const known = SIGNATURES.find(
    (signature) =>
      b.length >= signature.minLength && signature.parts.every(({ at, bytes }) => hasBytesAt(b, at, bytes)),
  );
  if (known) return known.type;
  let i = 0;
  while (i < b.length && JSON_SPACE.has(b[i]!)) i++;
  if (b[i] === 0x7b || b[i] === 0x5b) return 'application/json';
  return 'application/octet-stream';
}

/** The preimage behind `cid` through the host, keyed by the CID's digest, or
 *  null when the host has none or does not return in time. */
async function fromHost(cid: string): Promise<Uint8Array<ArrayBuffer> | null> {
  const address = artworkAddress(imageRefOfCid(cid));
  if (!address) return null;
  const manager = await getPreimageManager().catch(() => null);
  if (!manager) return null;
  const bytes = await preimageSource(manager, HOST_LOOKUP_MS)(address).catch(() => null);
  return bytes ? new Uint8Array(bytes) : null;
}

// Inside a host the network is granted per domain, so the gateway's domain is
// asked for once a session, the first time it is needed; the fetch runs anyway.
const GATEWAY_GRANT_MS = 8_000;
const grants = new Map<string, Promise<void>>();
function ensureDomainAccess(url: string): Promise<void> {
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return Promise.resolve();
  }
  let pending = grants.get(host);
  if (!pending) {
    pending = (async () => {
      try {
        const ask = Promise.resolve().then(() => requestPermission({ tag: 'Remote', value: { domains: [host] } }));
        const deadline = new Promise<null>((resolve) => setTimeout(() => resolve(null), GATEWAY_GRANT_MS));
        const result = await Promise.race([ask.catch(() => null), deadline]);
        if (result && !result.ok) console.warn(`[content] the host rejected network access to ${host}`, result.error);
        else if (result && !result.value) console.warn(`[content] network access to ${host} was not granted`);
      } catch {
        // no permission call on this host: the fetch decides
      }
    })();
    grants.set(host, pending);
  }
  return pending;
}

/** The bytes at `url` from the gateway, or null when it did not return them. */
async function fromGateway(url: string): Promise<ContentBytes | null> {
  await ensureDomainAccess(url);
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), GATEWAY_MS);
  try {
    const res = await fetch(url, { signal: control.signal });
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { bytes, type: res.headers.get('content-type') || sniffType(bytes) };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The first source to return bytes wins; null once every source has failed. */
function firstAnswer(sources: Promise<ContentBytes | null>[]): Promise<ContentBytes | null> {
  return new Promise((resolve) => {
    let left = sources.length;
    const miss = () => {
      if (--left === 0) resolve(null);
    };
    for (const source of sources) source.then((got) => (got ? resolve(got) : miss()), miss);
  });
}

/** The bytes behind `cid`. The host and the gateway are asked at once and the
 *  first bytes win; null means neither had them this time. */
export async function loadContentBytes(url: string, cid: string): Promise<ContentBytes | null> {
  const viaHost = fromHost(cid).then((bytes) => (bytes ? { bytes, type: sniffType(bytes) } : null));
  return firstAnswer([viaHost, fromGateway(url)]);
}

/** `verified`: the bytes hash to the CID; `transient`: nothing returned or no check,
 *  ask again; `rejected`: wrong bytes or an uncheckable CID, final. */
export type VerifiedContent = ({ verdict: 'verified' } & ContentBytes) | { verdict: 'transient' | 'rejected' };

export async function loadVerifiedContent(url: string, cid: string): Promise<VerifiedContent> {
  const got = await loadContentBytes(url, cid);
  if (!got) return { verdict: 'transient' };
  const verdict = await verdictOfBytes(cid, got.bytes);
  if (verdict !== 'verified') return { verdict };
  return { verdict, bytes: got.bytes, type: got.type };
}

/** Bytes already held, checked against `cid` with the same verdicts, so pictures
 *  saved on the device get the verdict a fresh fetch would. */
export async function verdictOfBytes(cid: string, bytes: Uint8Array): Promise<'verified' | 'transient' | 'rejected'> {
  const result = await getVerifiedArtwork(imageRefOfCid(cid), { source: () => Promise.resolve(bytes) });
  if (!result.ok) return 'transient';
  return result.value.tag === 'Verified' ? 'verified' : 'rejected';
}
