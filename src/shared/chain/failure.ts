// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// A write's failure (a claim, a gas top-up) as one of a few kinds the UI can put
// in the player's words and the flows can act on. Dispatch errors (a pallet
// rejected it) and validity errors (the pool rejected it, or the connection died)
// both end here. The raw text stays in `detail`, for the log only.

export type FailureKind =
  // The chain isn't ready yet (root not landed, proof still propagating). Not a
  // real failure: hold and let the next poll resolve it.
  | 'notReady'
  // The credit is spent already, usually a success this app did not see land;
  // the flows reconcile it.
  | 'alreadyDone'
  // The fee could not be paid: the host gave no gas, or the day's gas is spent
  // (credits/gas.ts). Retrying now won't help; try later.
  | 'fee'
  // Dropped / timed out / lost connection. Worth another attempt.
  | 'transient'
  // A standing, real problem (a wrong or unregistered collection). Needs the
  // player to do something different.
  | 'stuck'
  // This session cannot sign: the host gave no signer, or returned
  // PermissionDenied (for a claim, Jollity's manifest does not grant this app
  // `context`). Every claim fails the same way.
  | 'notAllowed';

export interface WriteFailure {
  kind: FailureKind;
  /** Technical reason, for the diagnostic log. NEVER shown to the player. */
  detail: string;
}

/** A nested `{ type, value }` error as its path of types, e.g.
 *  `['Module','NftClaims','AlreadyClaimed']`, the leaf last. */
export function errorPath(err: unknown): string[] {
  const parts: string[] = [];
  let cur: unknown = err;
  while (cur && typeof cur === 'object' && 'type' in cur && typeof cur.type === 'string') {
    const node = cur as { type: string; value?: unknown };
    parts.push(node.type);
    cur = node.value;
  }
  return parts;
}

/** Map a pallet error variant to a failure kind. */
function kindForVariant(leaf: string | undefined): FailureKind {
  switch (leaf) {
    // The credit is spent.
    case 'AlreadyClaimed':
      return 'alreadyDone';
    // The tree/proof hasn't caught up to the credit yet; try again in a moment.
    case 'UnknownAwardBlock':
    case 'UnknownCreditTree':
    case 'LeafIndexOutOfBounds':
    case 'InvalidProof':
      return 'notReady';
    // Standing problems with the collection: the same claim fails again.
    case 'CollectionNotRegistered':
    case 'CollectionOwnerChanged':
    case 'NotCollectionOwner':
    case 'UnknownCollection':
    case 'NoItems':
    // The identifier space is exhausted, or the instance is unknown.
    case 'StateNonceOverflow':
    case 'TooManyInstances':
    case 'UnknownInstance':
      return 'stuck';
    // The account already holds an NFT: the next try mints into a new one.
    case 'AddressOccupied':
      return 'transient';
    default:
      return 'stuck';
  }
}

/** Classify a dispatch error (an extrinsic that ran and was rejected). */
export function classifyDispatchError(err: { type: string; value: unknown } | undefined): WriteFailure {
  const path = errorPath(err);
  const detail = path.join(' · ') || 'the transaction failed on-chain';
  return { kind: kindForVariant(path[path.length - 1]), detail };
}

/** Classify a validity / stream error (the pool rejected it, or the connection
 *  died before inclusion). Message-based, since these arrive as plain errors. */
export function classifyValidityError(message: string): WriteFailure {
  if (message.includes('PermissionDenied')) return { kind: 'notAllowed', detail: message };
  const m = message.toLowerCase();
  const kind: FailureKind = /payment|balance|funds|inability to pay|no.*fee|can't pay|cannot pay/.test(m)
    ? 'fee'
    : 'transient';
  return { kind, detail: message };
}

/** The app's own failures before a write reaches the chain, so their kinds and
 *  wording stay the same everywhere. */
export const PREFLIGHT = {
  noConnection: { kind: 'transient', detail: 'no chain connection this session' },
  noCreditsChain: {
    kind: 'transient',
    detail: "can't reach the credits chain to prove this claim",
  },
  noIdentity: { kind: 'notAllowed', detail: 'no player identity to claim as' },
  cannotSign: { kind: 'notAllowed', detail: 'this session cannot sign a claim' },
  noPurses: { kind: 'notAllowed', detail: 'this host has no purses' },
  noProof: {
    kind: 'notReady',
    detail: 'no claim proof for this credit yet',
  },
} satisfies Record<string, WriteFailure>;

/** A thrown error (e.g. the host created no account) as a transient failure,
 *  worth another attempt rather than a hard stop out of the flow. */
export function fromThrown(err: unknown): WriteFailure {
  return { kind: 'transient', detail: err instanceof Error ? err.message : String(err) };
}
