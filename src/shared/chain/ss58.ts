// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// SS58 address helpers on top of @parity/product-sdk-address.

import { isValidSs58, ss58Decode, ss58Encode } from '@parity/product-sdk-address';
import { Binary } from 'polkadot-api';

/** The network prefix the app writes its addresses with. */
const SS58_PREFIX = 42;

/** The public key behind an SS58 address as 0x-hex, the same whatever its
 *  prefix; null when it does not parse. */
export function publicKeyHexOf(address: string): string | null {
  if (!isValidSs58(address)) return null;
  return Binary.toHex(ss58Decode(address).publicKey);
}

/** Returns the address of the account with this public key, given as bytes or as 0x-hex. */
export function addressOfPublicKey(publicKey: Uint8Array | `0x${string}`): string {
  const bytes = typeof publicKey === 'string' ? Binary.fromHex(publicKey) : publicKey;
  return ss58Encode(bytes, SS58_PREFIX);
}

/** Whether two addresses name the same account, whatever their prefixes: Asset
 *  Hub returns prefix 0, the app writes 42. Unparseable input is false. */
export function sameAccount(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const x = publicKeyHexOf(a);
  return x !== null && x === publicKeyHexOf(b);
}
