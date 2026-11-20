// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// The traits a collection describes, as the detail view lists them. Four comma
// separated lists name them in one order: `traits` (the item keys),
// `traitLabels`, `traitUnits` and `traitScoreMax`. An item holds a trait's
// value under its key and its score under `<key>_score`; its metadata carries
// the collection's keys too.

/** One trait of an item, ready to show. */
export interface TraitRow {
  /** The item metadata key the trait reads from. */
  key: string;
  label: string;
  unit: string;
  /** The value as the item holds it, a long whole number grouped in threes. */
  value: string;
  /** The score as the item holds it, the most it can be, and how far it fills
   *  its bar, from 0 to 1. Absent when the item holds no score. */
  score?: { text: string; max: string; fill: number };
}

/** The item's traits in the collection's order. None when the four lists
 *  disagree in length, and no row for a trait the item holds no value for. */
export function traitRows(metadata: Readonly<Record<string, string>> | undefined): TraitRow[] {
  if (!metadata) return [];
  const keys = listAt(metadata, 'traits');
  const labels = listAt(metadata, 'traitLabels');
  const units = listAt(metadata, 'traitUnits');
  const maxes = listAt(metadata, 'traitScoreMax');
  if (labels.length !== keys.length || units.length !== keys.length || maxes.length !== keys.length) return [];

  const rows: TraitRow[] = [];
  for (const [i, key] of keys.entries()) {
    const value = textAt(metadata, key);
    if (!value) continue;
    const row: TraitRow = { key, label: labels[i]!, unit: units[i]!, value: groupDigits(value) };

    // A score or a maximum that is no number draws no bar, nor does a maximum of 0.
    const score = textAt(metadata, `${key}_score`);
    const maxText = maxes[i]!;
    const max = numberOf(maxText);
    const fill = numberOf(score) / max;
    if (score && max > 0 && Number.isFinite(fill)) {
      row.score = { text: score, max: maxText, fill: Math.min(Math.max(fill, 0), 1) };
    }
    rows.push(row);
  }
  return rows;
}

/** Groups a whole number of five digits or more in threes (63190 reads 63,190,
 *  a year such as 1650 stays); other text passes unchanged. */
export function groupDigits(value: string): string {
  const parts = /^(-?)(\d{5,})(\.\d+)?$/.exec(value);
  if (!parts) return value;
  const [, sign = '', whole = '', fraction = ''] = parts;
  return `${sign}${whole.replace(/\B(?=(\d{3})+$)/g, ',')}${fraction}`;
}

/** A comma separated list the collection holds, its entries trimmed. Empty
 *  when the key is unset. */
function listAt(metadata: Readonly<Record<string, string>>, key: string): string[] {
  const text = textAt(metadata, key);
  return text === undefined ? [] : text.split(',').map((entry) => entry.trim());
}

/** The text under `key`, trimmed. A plain object also returns inherited keys
 *  such as `toString`, and those are no metadata. */
function textAt(metadata: Readonly<Record<string, string>>, key: string): string | undefined {
  const value: unknown = metadata[key];
  return typeof value === 'string' ? value.trim() : undefined;
}

/** A metadata text as a number: NaN when it is missing, empty or no number. */
const numberOf = (text: string | undefined): number => (text ? Number(text) : NaN);
