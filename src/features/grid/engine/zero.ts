// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// The preview for a player with no pieces: a few rare pieces bloom in full one
// at a time (picture only, never a name), then the lens drifts over rare spots
// to show the hold. A card in the dock's place shows how pieces arrive. Any
// touch stops the show; it comes back after 12 s idle.

import { artBig, artCell, CELL, wantArt, whenArt } from '../art';
import { catUrl, els, F, isRare, isShown, kick, motion, sx, sy, tok, TOPI, view } from './core';
import { type Task, tasks } from './core';
import { detailOpen } from './detail';
import { haptic } from './haptic';
import { layerOpen } from './history';
import { closeLoupe, engageLoupe, lensState, moveLoupe, setReadout } from './lens';
import { backOut, clamp, drawHalo, ease, fontPx, lerp, roundRect, shadowBlob, UI_FONT } from './util';

/** The empty-grid show: whether it runs, its blooms, timers and lens drift. */
const Z = {
  on: false,
  blooms: [] as { key: string; t0: number }[],
  timers: [] as number[],
  drift: null as Task | null,
  drifted: false,
  /** Held by key: the layout may move while the show runs. */
  showcase: [] as string[],
};

export const zeroBusy = (): boolean => Z.blooms.length > 0;

const later = (ms: number, fn: () => void): void => {
  Z.timers.push(window.setTimeout(fn, ms));
};
const clearTimers = (): void => {
  Z.timers.forEach((t) => window.clearTimeout(t));
  Z.timers = [];
};

/** Four rare pieces with pictures, from different collections where possible. */
function pickShowcase(): string[] {
  const byRegion = new Map<number, number[]>();
  F.layout.cells.forEach((c, i) => {
    if (!c.rare || !c.imageUrl || isShown(i)) return;
    const r = F.layout.areas[c.area]!.region;
    const list = byRegion.get(r) ?? [];
    list.push(i);
    byRegion.set(r, list);
  });
  const lists = [...byRegion.values()];
  const out: number[] = [];
  for (let round = 0; out.length < 4 && lists.some((l) => l.length > round); round++)
    for (const l of lists) {
      const pick = l[Math.floor((l.length * (round * 2 + 1)) / 8)] ?? l[round];
      if (pick !== undefined && !out.includes(pick) && out.length < 4) out.push(pick);
    }
  return out.map((i) => F.layout.cells[i]!.key);
}

const showcaseIdx = (): number[] =>
  Z.showcase.map((k) => F.layout.index.get(k)).filter((i): i is number => i !== undefined);

export function zeroStart(): void {
  Z.on = true;
  Z.drifted = false;
  Z.showcase = pickShowcase();
  for (const i of showcaseIdx()) wantArt(catUrl(i), 20);
  later(motion.reduced ? 300 : 1200, () => {
    if (!Z.on) return;
    els.zcard.classList.add('is-show');
    els.app.classList.add('is-zcarding');
  });
  cycle(motion.reduced ? 300 : 600);
}

/** Starts the show over on a new field when it had no piece to bloom: a
 *  catalogue landed after the grid opened empty. */
export function restartEmptyShow(): void {
  if (!Z.on || Z.showcase.length) return;
  clearTimers();
  zeroStart();
}

const onScreen = (i: number): boolean => {
  const x = sx(F.layout.px[i]!);
  const y = sy(F.layout.py[i]!);
  return x > 0 && x < view.W && y > TOPI && y < view.H - 190;
};

function cycle(delay: number): void {
  if (!Z.on) return;
  let t = delay;
  for (const key of Z.showcase) {
    later(t, () => {
      // A picture still loading blooms once it is in.
      const bloom = (): void => {
        const i = F.layout.index.get(key);
        if (i === undefined || !Z.on || detailOpen() || !onScreen(i)) return;
        Z.blooms.push({ key, t0: performance.now() });
        haptic('tick');
        kick();
      };
      const i = F.layout.index.get(key);
      if (i === undefined) return;
      if (artCell(catUrl(i))) bloom();
      else void whenArt(catUrl(i) ?? '', 40).then((src) => src && bloom());
    });
    t += 1900;
  }
  if (!Z.drifted) {
    later(t + 400, drift);
    t += 7000;
  }
  later(t + 12000, () => cycle(0));
}

/** Any input: the blooms fade, the drift stops, and the show waits 12 s. */
export function zeroInput(): void {
  if (!Z.on) return;
  clearTimers();
  const now = performance.now();
  for (const b of Z.blooms) if (now - b.t0 < 1900) b.t0 = now - 1900;
  if (Z.drift) {
    tasks.delete(Z.drift);
    Z.drift = null;
  }
  // The preview's lens, mid-drift or parked on its tip once the drift is done.
  if (lensState.on && lensState.auto) closeLoupe();
  later(12000, () => cycle(0));
}

export function zeroEnd(): void {
  if (!Z.on) return;
  zeroInput();
  clearTimers();
  Z.on = false;
  els.zcard.classList.remove('is-show');
  els.app.classList.remove('is-zcarding');
}

/** The card's Look around: put the card away and bring the dock back. */
export function zeroLook(): void {
  els.zcard.classList.remove('is-show');
  els.app.classList.remove('is-zcarding');
}

export function drawBlooms(c: CanvasRenderingContext2D, now: number): void {
  if (!Z.blooms.length) return;
  const B = clamp(view.W * 0.24, 72, 110);
  Z.blooms = Z.blooms.filter((b) => now - b.t0 < 2300);
  for (const b of Z.blooms) {
    const k = (now - b.t0) / 1000;
    const i = F.layout.index.get(b.key);
    if (i === undefined) continue;
    let sc: number;
    let al: number;
    if (k < 0.5) {
      sc = motion.reduced ? 1 : backOut(k / 0.5, 2.2);
      al = clamp(k / 0.2, 0, 1);
    } else if (k < 1.9) {
      sc = 1;
      al = 1;
    } else {
      const p = (k - 1.9) / 0.4;
      sc = motion.reduced ? 1 : 1 - 0.75 * p;
      al = 1 - p;
    }
    const x = clamp(sx(F.layout.px[i]!), B / 2 + 8, view.W - B / 2 - 8);
    const y = clamp(sy(F.layout.py[i]!), TOPI + B / 2 + 8, view.H - 210);
    const sz = B * Math.max(0.05, sc);
    const url = catUrl(i);
    const art = artCell(url);
    drawHalo(c, x, y, sz * 0.78, now / 18, 0.95 * al);
    c.globalAlpha = tok.shadowa * 0.8 * al;
    c.drawImage(shadowBlob(), x - sz * 0.36, y + sz * (0.5 - (art?.gap ?? 0.05)) - sz * 0.05, sz * 0.72, sz * 0.13);
    const big = artBig(url);
    c.globalAlpha = al;
    if (big) c.drawImage(big, x - sz / 2, y - sz / 2, sz, sz);
    else if (art) c.drawImage(art.page, art.sx, art.sy, CELL, CELL, x - sz / 2, y - sz / 2, sz, sz);
    const label = 'Rare · could be in your next game';
    c.font = fontPx(12, 600, UI_FONT);
    const tw = c.measureText(label).width + 20;
    const ty = y + B / 2 + 10;
    const ca = k < 1.9 ? clamp((k - 0.15) / 0.25, 0, 1) : Math.max(0, 1 - (k - 1.9) / 0.12);
    c.globalAlpha = ca;
    c.fillStyle = tok.surface;
    c.strokeStyle = tok.fg3;
    c.lineWidth = 1;
    roundRect(c, clamp(x - tw / 2, 8, view.W - tw - 8), ty, tw, 26, 13);
    c.fill();
    c.globalAlpha = ca * 0.5;
    c.stroke();
    c.globalAlpha = ca;
    c.fillStyle = tok.fg;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(label, clamp(x, tw / 2 + 8, view.W - tw / 2 - 8), ty + 13.5);
    c.textAlign = 'left';
    c.textBaseline = 'alphabetic';
  }
  c.globalAlpha = 1;
}

/** The lens rises on its own over three rare spots, then shows how to do it. */
function drift(): void {
  if (!Z.on || detailOpen() || lensState.on || layerOpen()) return;
  const cand: number[] = [];
  F.layout.cells.forEach((_, i) => {
    if (!isRare(i) || isShown(i) || Z.showcase.includes(F.layout.cells[i]!.key)) return;
    const x = sx(F.layout.px[i]!);
    const y = sy(F.layout.py[i]!);
    if (x > 70 && x < view.W - 70 && y > 340 && y < view.H - 210) cand.push(i);
  });
  if (cand.length < 3) return;
  cand.sort((a, b) => sx(F.layout.px[a]!) - sx(F.layout.px[b]!));
  const pts = [0.15, 0.5, 0.85].map((f) => {
    const i = cand[Math.floor(cand.length * f)]!;
    return [sx(F.layout.px[i]!), sy(F.layout.py[i]!)] as const;
  });
  Z.drifted = true;
  engageLoupe(pts[0]![0], pts[0]![1], true, true);
  els.touchDot.classList.add('is-on');
  const t0 = performance.now();
  const seg = motion.reduced ? 1 : 1300;
  const task: Task = (now) => {
    const k = Math.max(0, (now - t0) / seg);
    if (k >= 3) {
      Z.drift = null;
      setReadout('Press and hold anywhere to look closer', 'Then slide to look around');
      later(2200, () => {
        if (lensState.sticky) closeLoupe();
      });
      return false;
    }
    const j = Math.min(1, Math.floor(k));
    const p = ease(clamp(k - j, 0, 1));
    const a = pts[j]!;
    const b = pts[Math.min(2, j + 1)]!;
    if (k < 2) moveLoupe(lerp(a[0], b[0], p), lerp(a[1], b[1], p));
    return true;
  };
  Z.drift = task;
  tasks.add(task);
  kick();
}
