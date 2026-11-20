// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';

import { classifyDispatchError, classifyValidityError, errorPath, type FailureKind } from './failure';

/** A nested Module dispatch error, the shape papi decodes: Module → pallet →
 *  variant. */
const moduleErr = (pallet: string, variant: string) => ({
  type: 'Module',
  value: { type: pallet, value: { type: variant } },
});

describe('errorPath', () => {
  it('flattens a nested dispatch error to its type path', () => {
    expect(errorPath(moduleErr('NftClaims', 'AlreadyClaimed'))).toEqual(['Module', 'NftClaims', 'AlreadyClaimed']);
  });
  it('is empty for undefined or a non-enum value', () => {
    expect(errorPath(undefined)).toEqual([]);
    expect(errorPath({})).toEqual([]);
    expect(errorPath('nope')).toEqual([]);
  });
});

describe('classifyDispatchError', () => {
  const cases: [string, string, FailureKind][] = [
    ['NftClaims', 'AlreadyClaimed', 'alreadyDone'],
    ['NftClaims', 'UnknownAwardBlock', 'notReady'],
    ['NftClaims', 'UnknownCreditTree', 'notReady'],
    ['NftClaims', 'LeafIndexOutOfBounds', 'notReady'],
    ['NftClaims', 'InvalidProof', 'notReady'],
    ['NftClaims', 'CollectionNotRegistered', 'stuck'],
    ['NftClaims', 'UnknownCollection', 'stuck'],
    ['NftClaims', 'NoItems', 'stuck'],
    // The next try mints into a new account.
    ['Scarcity', 'AddressOccupied', 'transient'],
    // Anything unrecognised is a standing problem, not a silent retry.
    ['Scarcity', 'SomethingNew', 'stuck'],
  ];
  it.each(cases)('%s · %s → %s', (pallet, variant, kind) => {
    const f = classifyDispatchError(moduleErr(pallet, variant));
    expect(f.kind).toBe(kind);
    expect(f.detail).toBe(`Module · ${pallet} · ${variant}`);
  });
  it('falls back for an absent dispatch error', () => {
    const f = classifyDispatchError(undefined);
    expect(f).toEqual({ kind: 'stuck', detail: 'the transaction failed on-chain' });
  });
});

describe('classifyValidityError', () => {
  it('reads a payment/funds failure as a fee problem', () => {
    for (const m of [
      'Invalid Transaction: Inability to pay some fees',
      'insufficient funds',
      'ChargeAssetTxPayment: Payment',
    ]) {
      expect(classifyValidityError(m).kind).toBe('fee');
    }
  });
  it('reads a PermissionDenied from the host as notAllowed', () => {
    expect(classifyValidityError('createTransaction failed: PermissionDenied').kind).toBe('notAllowed');
  });
  it('reads everything else as transient (worth another try)', () => {
    for (const m of ['connection dropped', 'timed out', 'socket closed', 'whatever']) {
      expect(classifyValidityError(m).kind).toBe('transient');
    }
  });
  it('keeps the raw message as detail (for the log, not the player)', () => {
    expect(classifyValidityError('boom').detail).toBe('boom');
  });
});
