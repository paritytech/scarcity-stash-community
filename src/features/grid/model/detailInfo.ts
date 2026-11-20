// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// The detail view's description and traits, read from a piece's metadata. The
// collection names its traits on chain (collections/traits.ts), so nothing
// here lists them.

import { type TraitRow, traitRows } from '@/entities/collections/traits';

export interface DetailInfo {
  desc?: string;
  traits: TraitRow[];
}

/** A value the chain could not read as text arrives as hex: never shown. */
const unreadable = (v: string): boolean => /^0x[0-9a-f]*$/i.test(v.trim());

/** What the detail shows for `metadata`. A description the whole collection
 *  shares (`shared`) belongs to the collection, so it is left out. */
export function detailInfo(metadata: Readonly<Record<string, string>> | undefined, shared?: string): DetailInfo {
  const out: DetailInfo = { traits: [] };
  if (!metadata) return out;
  const desc = metadata.description?.trim();
  if (desc && !unreadable(desc) && desc !== shared?.trim()) out.desc = desc;
  out.traits = traitRows(metadata).filter((t) => !unreadable(t.value));
  return out;
}

export const hasInfo = (info: DetailInfo): boolean => Boolean(info.desc) || info.traits.length > 0;
