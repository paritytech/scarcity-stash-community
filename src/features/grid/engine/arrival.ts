// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// Arrivals: pieces new since you last looked. A pill names the moment ("3 new
// pieces"), then one orb per copy flies in, 120 ms apart; a piece is yours when
// its orb lands. An arrival waits for a quiet grid (nothing open, no lens, no
// finger down), and orbs follow their piece by key, so a pan or a catalogue
// landing mid-flight still brings each to its piece.

import { artCell, CELL, whenCell } from '../art';
import { pieceSize } from '../model/grid';
import { fitAll, fitRows, framePiece, scrollTo } from './camera';
import { cam, els, F, flags, grid, isRare, kick, motion, nameOf, ownUrl, sx, sy, type Task, tasks, tok } from './core';
import { detailOpen, rectOf } from './detail';
import { onlyNew, recomputeMatches, toggleNew, updateNewBtn } from './filters';
import { pointerActive } from './gestures';
import { haptic } from './haptic';
import { freezeCount, setCount } from './header';
import { hideHint, lastInputAt, scheduleHint } from './hint';
import { layerOpen } from './history';
import { lensState } from './lens';
import { refreshCounts } from './render';
import { markSeen } from './seen';
import { backOut, clamp, lerp, wait } from './util';
import { zeroEnd } from './zero';

export interface ArrivalPlan {
  /** Cell keys, one per copy arriving, in the order their orbs leave. */
  keys: string[];
  /** The keys drawn as missing until their orb lands: pieces new to the
   *  player. A new copy of a piece already on the grid is not hidden. */
  hold: string[];
  /** The pill's words. */
  title: string;
  /** A first collection: the camera stays on the whole field. */
  first?: boolean;
}

let busy = false;
let gen = 0;
/** showNew: the pill was tapped while orbs flew. landed: every orb is home and
 *  the pill shows it, so a tap acts at once. */
const pillState = { showNew: false, landed: false };
/** Read through a call: the pill's tap lands while play() awaits. */
const wantsNew = (): boolean => pillState.showNew;
const orbTasks = new Set<Task>();
const queue: ArrivalPlan[] = [];
/** Pieces whose arrival has played this session: a remount never plays it again. */
const arrived = new Set<string>();

export const arrivalBusy = (): boolean => busy;
export const hasArrived = (key: string): boolean => arrived.has(key);

const indexOf = (key: string): number | undefined => F.layout.index.get(key);

/** Stop any arrival at once: the pieces it held back appear where they are. */
export function cancelArrival(): void {
  gen++;
  for (const t of orbTasks) tasks.delete(t);
  orbTasks.clear();
  els.orbs.textContent = '';
  busy = false;
  queue.length = 0;
  F.held.clear();
  F.appear.fill(1);
  freezeCount(false);
  els.pill.classList.remove('is-show');
}

/** The pill tapped: show what arrived (New), now or once it lands. */
export function pillTapped(): void {
  if (!els.pill.classList.contains('is-show')) return;
  if (busy && !pillState.landed) {
    pillState.showNew = true;
    return;
  }
  els.pill.classList.remove('is-show');
  if (!onlyNew()) toggleNew();
}

/** Queue an arrival. Its cells are held back (drawn as missing) at once, so
 *  nothing appears before its orb lands. */
export function planArrival(plan: ArrivalPlan): void {
  for (const k of plan.hold) F.held.add(k);
  queue.push(plan);
  flags.dirty = true;
  kick();
  if (!busy) void next();
}

async function next(): Promise<void> {
  const plan = queue.shift();
  if (!plan) return;
  await play(plan);
  if (queue.length) void next();
}

/** Nothing open, no lens the player raised and no finger down. The empty-grid
 *  show's own lens does not count: the arrival puts it away. */
const quiet = (): boolean => !layerOpen() && !detailOpen() && !(lensState.on && !lensState.auto) && !pointerActive();

async function play(plan: ArrivalPlan): Promise<void> {
  busy = true;
  const myGen = gen;
  const alive = (): boolean => myGen === gen;
  while (!quiet()) {
    await wait(250);
    if (!alive()) return;
  }
  zeroEnd();
  hideHint();
  if (!plan.first) await wait(150);
  if (!alive()) return;
  const keys = plan.keys.filter((k) => indexOf(k) !== undefined);
  for (const k of plan.keys) if (!keys.includes(k)) F.held.delete(k);
  if (!keys.length) {
    busy = false;
    freezeCount(false);
    setCount(F.foundCount);
    return;
  }
  const t0 = performance.now();
  pillState.showNew = false;
  pillState.landed = false;
  // The pill shows what is coming straight away; its spinner turns while the
  // pictures load, so every orb carries its piece.
  els.pillText.textContent = plan.title;
  els.pill.classList.remove('is-done');
  els.pill.classList.add('is-show');
  haptic('medium');
  await Promise.race([Promise.all(keys.map((k) => whenCell(ownUrl(indexOf(k) ?? -1) ?? '', 80))), wait(3000)]);
  if (!alive()) return;
  if (!plan.first) {
    let y0 = 1e9;
    let y1 = -1e9;
    const { py } = F.layout;
    for (const k of keys) {
      const i = indexOf(k);
      if (i === undefined) continue;
      y0 = Math.min(y0, py[i]!);
      y1 = Math.max(y1, py[i]!);
    }
    await new Promise<void>((res) => fitRows(y0 - 1, y1 + 1, () => res()));
  } else if (grid.z > 0) {
    // A first collection comes in at the closest step the whole grid fits, so every orb lands in view.
    await new Promise<void>((res) => fitAll(false, () => res()));
  }
  if (!alive()) return;
  els.pill.classList.add('is-flying');
  await wait(120);
  if (!alive()) return;
  const pr = rectOf(els.pill);
  const from = { x: pr.x + pr.w / 2, y: pr.y + pr.h + 4 };
  let landed = 0;
  // Orbs leave 120 ms apart; a big haul (a whole collection on a new phone)
  // leaves faster so it is all home within a few seconds.
  const gap = Math.min(120, 3600 / keys.length);
  for (const k of keys) {
    launchOrb(k, from.x, from.y, () => {
      land(k);
      landed++;
    });
    await wait(gap);
    if (!alive()) return;
  }
  while (landed < keys.length) {
    await wait(40);
    if (!alive()) return;
  }
  setCount(F.foundCount);
  updateNewBtn();
  recomputeMatches();
  await wait(500);
  if (!alive()) return;
  const lastKey = keys[keys.length - 1]!;
  els.pill.classList.remove('is-flying');
  els.pill.classList.add('is-done');
  const one = new Set(keys).size === 1 && keys.length === 1;
  const j = indexOf(lastKey);
  els.pillText.textContent =
    one && j !== undefined && nameOf(j) ? `${nameOf(j)} is in your collection` : 'Added to your collection';
  pillState.landed = true;
  const i = indexOf(lastKey);
  if (wantsNew()) {
    els.pill.classList.remove('is-show');
    toggleNew();
  } else if (lastInputAt() < t0 && !detailOpen() && i !== undefined) {
    scrollTo(framePiece(i), 900, (cut) => {
      const j = indexOf(lastKey);
      if (cut || j === undefined) return;
      F.focusI = j;
      F.focusT = performance.now();
      kick();
    });
  }
  await wait(1800);
  if (!alive()) return;
  els.pill.classList.remove('is-show', 'is-flying');
  busy = false;
  pillState.landed = false;
  scheduleHint();
}

function land(key: string): void {
  F.held.delete(key);
  arrived.add(key);
  freezeCount(false);
  refreshCounts();
  const now = performance.now();
  const i = indexOf(key);
  if (i !== undefined) {
    markSeen(i);
    if (motion.reduced) F.appear[i] = 1;
    else {
      F.appear[i] = 0;
      tasks.add((t) => {
        const j = indexOf(key);
        if (j === undefined) return false;
        const p = clamp((t - now) / 420, 0, 1);
        F.appear[j] = backOut(p, 1.25);
        flags.dirty = true;
        return p < 1;
      });
    }
    F.flash.set(i, now);
    if (isRare(i)) F.burst.set(i, now);
  }
  setCount(F.foundCount);
  if (!motion.reduced)
    els.countLine.animate([{ transform: 'scale(1.1)' }, { transform: 'none' }], {
      duration: 240,
      easing: 'cubic-bezier(.2,.9,.25,1)',
    });
  haptic('light');
  flags.dirty = true;
  kick();
}

function launchOrb(key: string, x0: number, y0: number, onLand: () => void): void {
  const orb = document.createElement('div');
  orb.className = 'grid-orb';
  const oc = document.createElement('canvas');
  oc.width = oc.height = 96;
  const art = artCell(ownUrl(indexOf(key) ?? -1));
  const g = oc.getContext('2d')!;
  if (art) g.drawImage(art.page, art.sx, art.sy, CELL, CELL, 0, 0, 96, 96);
  else {
    // The picture is still on its way: a soft light rather than an empty orb.
    const grad = g.createRadialGradient(48, 48, 4, 48, 48, 40);
    grad.addColorStop(0, tok.fg);
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.globalAlpha = 0.55;
    g.fillRect(0, 0, 96, 96);
  }
  orb.appendChild(oc);
  els.orbs.appendChild(orb);
  const t0 = performance.now();
  // Where the piece is on screen now: looked up each frame, since the layout
  // may move under the flight.
  const target = (): [number, number] => {
    const i = indexOf(key);
    return i === undefined ? [x0, y0] : [sx(F.layout.px[i]!), sy(F.layout.py[i]!)];
  };
  const [tx, ty] = target();
  const dur = motion.reduced ? 1 : 620 + Math.hypot(tx - x0, ty - y0) * 0.35;
  const task: Task = (now) => {
    const [x1, y1] = target();
    const cx = x0 + (x1 - x0) * 0.2;
    const cy = y0 + 40;
    const end = Math.max(pieceSize(cam.s), 14) / 56;
    const p = clamp((now - t0) / dur, 0, 1);
    const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
    const u = 1 - e;
    const x = u * u * x0 + 2 * u * e * cx + e * e * x1;
    const y = u * u * y0 + 2 * u * e * cy + e * e * y1;
    const s = lerp(0.25, end, e) + Math.sin(p * Math.PI) * 0.55;
    orb.style.transform = `translate3d(${x - 28}px,${y - 28}px,0) scale(${s.toFixed(3)}) rotate(${(p * 200).toFixed(1)}deg)`;
    if (p >= 1) {
      orbTasks.delete(task);
      orb
        .animate([{ opacity: 1 }, { opacity: 0 }], { duration: 220 })
        .finished.then(() => orb.remove())
        .catch(() => orb.remove());
      onLand();
      return false;
    }
    return true;
  };
  orbTasks.add(task);
  tasks.add(task);
  kick();
}
