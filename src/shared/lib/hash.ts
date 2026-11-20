// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// Hash-identity helpers shared by the chain layer, the collection store and
// the view models. One definition of "normalized hash": a mismatch between
// two hand-rolled copies turns into "credit doesn't match its item" bugs.

/** A hash in the one form it is compared and kept in: trimmed, no 0x,
 *  lowercase. Other identities pass through lowercased. */
export function normalizeHash(hash: string): string {
  const h = hash.trim();
  return (h.startsWith('0x') || h.startsWith('0X') ? h.slice(2) : h).toLowerCase();
}

/** A short serial for the screen, the hash's first and last four digits
 *  ("7F3A·9C2B"); a non-hex identity passes through whole. */
export function shortCode(hash: string): string {
  const h = normalizeHash(hash).toUpperCase();
  if (!/^[0-9A-F]+$/.test(h)) return h;
  if (h.length < 8) return h;
  return `${h.slice(0, 4)}·${h.slice(-4)}`;
}
