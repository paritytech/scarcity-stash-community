// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// The header's two lines: the app's name and the count ("10 of 148 found"),
// rolling to a new total. While a collection's total is unknown the count shows
// only what was found. Once a collection's title scrolls under the bar, the
// lines are its name and count until its card scrolls out.

import { els, F, kick, motion, type Task, tasks } from './core';
import { clamp } from './util';

/** What the bar reads at the top of the grid. */
export const HOME_TITLE = 'Collectibles';

let shown = 0;
/** The count of the whole grid, as last written. */
let wholeLine = '';
/** The collection whose name is in the bar, by region index; -1 at the top. */
let pinned = -1;
let rolling: Task | null = null;
/** The first arrival keeps the count blank until its first piece lands. */
let frozen = false;

export function freezeCount(on: boolean): void {
  frozen = on;
}

/** Whether the grid's total is known: it has pieces, and no catalogue is missing. */
const totalKnown = (): boolean => F.layout.cells.length > 0 && !F.layout.regions.some((r) => r.partial);

function writeCount(n: number): void {
  shown = n;
  const total = F.layout.cells.length;
  const found = totalKnown()
    ? n
      ? `${n} of ${total} found`
      : `${total} pieces to find`
    : n
      ? `${n} found`
      : 'Nothing found yet';
  wholeLine = found;
  els.field.setAttribute('aria-label', `Collectibles grid: ${wholeLine}`);
  writeLines();
}

function writeLines(): void {
  const region = F.layout.regions[pinned];
  const own = F.regionOwn[pinned] ?? 0;
  const title = region ? region.name : HOME_TITLE;
  const line = !region ? wholeLine : region.partial ? `${own} found` : `${own} of ${F.regionTot[pinned] ?? 0} found`;
  if (els.title.textContent !== title) els.title.textContent = title;
  if (els.countLine.textContent !== line) els.countLine.textContent = line;
}

/** Region `r` has its name in the bar from now on; -1 gives the bar back to
 *  the app's name. Called every frame, so it writes only on a change. */
export function pinRegion(r: number): void {
  if (r === pinned) return;
  pinned = r;
  els.head.classList.toggle('is-pinned', r >= 0);
  writeLines();
}

/** Show `n` now, ending any roll. */
export function setCount(n: number): void {
  if (rolling) {
    tasks.delete(rolling);
    rolling = null;
  }
  writeCount(n);
}

function rollCount(): void {
  const from = shown;
  const t0 = performance.now();
  const dur = motion.reduced ? 1 : Math.min(900, 300 + Math.abs(F.foundCount - from) * 4);
  if (rolling) tasks.delete(rolling);
  // The target is read every frame: a piece landing mid-roll moves it.
  const task: Task = (now) => {
    const p = clamp((now - t0) / dur, 0, 1);
    const e = 1 - Math.pow(1 - p, 3);
    writeCount(Math.round(from + (F.foundCount - from) * e));
    if (p < 1) return true;
    if (rolling === task) rolling = null;
    return false;
  };
  rolling = task;
  tasks.add(task);
  kick();
}

export function updateHeader(roll = false): void {
  if (frozen) return;
  if (roll) rollCount();
  else setCount(F.foundCount);
}
