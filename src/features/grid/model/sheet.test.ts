// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { pullsSheet, wheelOpens } from './sheet';

const EXPANDED = { expanded: true, land: false };
const PEEK = { expanded: false, land: false };
const LAND = { expanded: false, land: true };

describe('pullsSheet', () => {
  it('takes a pull down from the top of the expanded body', () => {
    expect(pullsSheet(EXPANDED, 0, 3)).toBe(true);
  });

  it('takes it while iOS springs the body back past its top', () => {
    expect(pullsSheet(EXPANDED, -12, 2)).toBe(true);
  });

  it('leaves a finger moving up to the body, at the top or not', () => {
    expect(pullsSheet(EXPANDED, 0, -3)).toBe(false);
    expect(pullsSheet(EXPANDED, 240, -3)).toBe(false);
  });

  it('leaves a pull down to the body once it has scrolled', () => {
    expect(pullsSheet(EXPANDED, 1, 3)).toBe(false);
  });

  it('never takes a gesture in peek or in landscape', () => {
    expect(pullsSheet(PEEK, 0, 3)).toBe(false);
    expect(pullsSheet(LAND, 0, 3)).toBe(false);
  });
});

describe('wheelOpens', () => {
  it('opens peek on a wheel turned toward more', () => {
    expect(wheelOpens({ ...PEEK, info: true }, 0, 24)).toBe(true);
  });

  it('keeps peek on a wheel turned back, sideways, or with nothing more to show', () => {
    expect(wheelOpens({ ...PEEK, info: true }, 0, -24)).toBe(false);
    expect(wheelOpens({ ...PEEK, info: true }, 30, 10)).toBe(false);
    expect(wheelOpens({ ...PEEK, info: false }, 0, 24)).toBe(false);
  });

  it('leaves an expanded or landscape sheet to its own scroll', () => {
    expect(wheelOpens({ ...EXPANDED, info: true }, 0, 24)).toBe(false);
    expect(wheelOpens({ ...LAND, info: true }, 0, 24)).toBe(false);
  });
});

/** Every source file under `dir`. */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(path));
    else if (/\.(ts|tsx|css)$/.test(entry.name) && !entry.name.endsWith('.test.ts')) out.push(path);
  }
  return out;
}

describe('touch-action', () => {
  // WebKit drops a declaration or a style write naming one of these, and the
  // element keeps whatever it had, so on iOS such a gesture silently never runs.
  const DIRECTIONAL = /pan-(up|down|left|right)\b/;
  const IN_CSS = new RegExp(`touch-action\\s*:[^;]*${DIRECTIONAL.source}`);
  const IN_CODE = new RegExp(`['"\`][^'"\`\\n]*${DIRECTIONAL.source}[^'"\`\\n]*['"\`]`);

  it('names only values every engine implements', () => {
    const found: string[] = [];
    for (const file of sources(join(__dirname, '..', '..', '..'))) {
      const text = readFileSync(file, 'utf8');
      if ((file.endsWith('.css') ? IN_CSS : IN_CODE).test(text)) found.push(file);
    }
    expect(found).toEqual([]);
  });
});
