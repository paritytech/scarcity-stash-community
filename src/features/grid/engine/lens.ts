// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// The lens: press and hold, and a loupe rises above the finger, magnifying the
// field through a fisheye, naming what it is over, and opening a held piece on
// release. Only a deliberate push into the top 170 px scrolls the grid, after a
// 250 ms dwell, at most 4 rows a second.

import { artBig, artCell, artSilhouette, CELL, wantArt } from '../art';
import { shortDate } from '../model/days';
import { lensPieceSide, pieceSize } from '../model/grid';
import { camBounds, camMoved, stopCam } from './camera';
import {
  areaOfI,
  areaPlace,
  cam,
  catUrl,
  els,
  F,
  filter,
  flags,
  foundAt,
  isRare,
  isShown,
  kick,
  motion,
  nameOf,
  ownUrl,
  placeOf,
  sx,
  sy,
  type Task,
  tasks,
  tok,
  view,
  wx,
  wy,
} from './core';
import { fActive } from './filters';
import { cellSize } from './grid';
import { haptic, setTickMute } from './haptic';
import { syncHistory } from './history';
import { tilt } from './tilt';
import { clamp, drawHalo, fish, shadowBlob, Spring } from './util';

const LENS_UP = 150;
const LENS_TOP = 128;
const LENS_SIDE = 84;
const EDGE_BAND = 170;
const EDGE_FULL = 90;
const EDGE_ROWS = 4;
const EDGE_DWELL = 250;
const EDGE_RAMP = 300;

export const lensState = {
  on: false,
  sticky: false,
  auto: false,
  tx: 0,
  ty: 0,
  sel: -2,
  near: false,
  selShown: false,
  armed: false,
  engY: 0,
  lx: new Spring(0, 520, 40),
  ly: new Spring(0, 520, 40),
  sc: new Spring(0, 380, 24),
  fx: new Spring(0, 900, 60),
  fy: new Spring(0, 900, 60),
  fade: null as Animation | null,
  ld: 1,
};
const L = lensState;

const lensTarget = (tx: number, ty: number): [number, number] => [
  clamp(tx, LENS_SIDE, view.W - LENS_SIDE),
  Math.max(ty - LENS_UP, LENS_TOP),
];

let edgeTask: Task | null = null;
let edgeV = 0;
let edgeIn = 0;
export const edgeActive = (): boolean => edgeTask !== null;

/** Clears an edge scroll whose task went with a detach. */
export function resetEdge(): void {
  edgeTask = null;
  edgeV = 0;
  setTickMute(false);
}

function edgeScroll(): void {
  if (edgeTask) return;
  let t0 = performance.now();
  edgeIn = t0;
  const task: Task = (now) => {
    const dt = Math.max(0, Math.min(0.034, (now - t0) / 1000));
    t0 = now;
    const inBand = L.on && L.armed && !L.sticky && L.ty < EDGE_BAND;
    if (!inBand) edgeIn = now;
    const depth = clamp((EDGE_BAND - L.ty) / (EDGE_BAND - EDGE_FULL), 0, 1);
    const ramp = clamp((now - edgeIn - EDGE_DWELL) / EDGE_RAMP, 0, 1);
    const room = Math.max(0, cam.y - camBounds().y0);
    const target = Math.min(inBand ? EDGE_ROWS * depth * depth * ramp : 0, room / 0.15);
    edgeV += (target - edgeV) * Math.min(1, dt / 0.08);
    setTickMute(edgeV > 0.2);
    if (!inBand && edgeV < 0.02) {
      edgeV = 0;
      edgeTask = null;
      setTickMute(false);
      return false;
    }
    if (edgeV > 0.001) {
      cam.y -= edgeV * dt;
      camMoved();
      moveLoupe(L.tx, L.ty);
    }
    return true;
  };
  edgeTask = task;
  tasks.add(task);
  kick();
}

/** Raise the lens at (tx, ty). A sticky lens stays up after the finger lifts
 *  (a tap on a missing piece parks it there); an auto lens moves on its own. */
export function engageLoupe(tx: number, ty: number, sticky = false, auto = false): void {
  stopCam();
  if (L.fade) {
    L.fade.cancel();
    L.fade = null;
  }
  L.on = true;
  L.sticky = sticky;
  L.auto = auto;
  syncHistory();
  L.armed = ty >= EDGE_BAND;
  L.engY = ty;
  const [lx, ly] = lensTarget(tx, ty);
  if (!L.sc.x || !els.loupe.classList.contains('is-on')) {
    L.lx.snap(tx);
    L.ly.snap(ty);
    L.sc.snap(0);
  }
  L.lx.set(lx);
  L.ly.set(ly);
  if (motion.reduced) {
    L.lx.snap(lx);
    L.ly.snap(ly);
    L.sc.snap(1);
  } else L.sc.set(1);
  L.fx.snap(tx);
  L.fy.snap(ty);
  L.sel = -2;
  els.loupe.classList.add('is-on');
  els.touchDot.classList.toggle('is-on', !sticky);
  els.head.classList.add('is-reading');
  haptic('light');
  moveLoupe(tx, ty);
  kick();
}

/** The nearest cell to screen point (px, py) within `radius`, passing `ok`. */
export function nearestItem(px: number, py: number, radius: number, ok?: (i: number) => boolean): [number, number] {
  let best = -1;
  let bd = radius;
  const w0 = wx(px);
  const w1 = wy(py);
  const R = radius / cam.s + 1;
  const { areas, px: X, py: Y } = F.layout;
  for (const a of areas) {
    if (w0 < a.x - R || w0 > a.x + a.w + R || w1 < a.y - R || w1 > a.y + a.h + R) continue;
    for (let i = a.from; i < a.to; i++) {
      if (ok && !ok(i)) continue;
      const d = Math.hypot(sx(X[i]!) - px, sy(Y[i]!) - py);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
  }
  return [best, bd];
}

/** The area nearest world point (x, y). */
export function areaAt(x: number, y: number): number {
  let best = -1;
  let bd = 1e9;
  for (const a of F.layout.areas) {
    const dx = Math.max(a.x - x, 0, x - (a.x + a.w));
    const dy = Math.max(a.y - y, 0, y - (a.y + a.h));
    const d = Math.hypot(dx, dy);
    if (d < bd) {
      bd = d;
      best = a.idx;
    }
  }
  return best;
}

export function moveLoupe(tx: number, ty: number): void {
  L.tx = tx;
  L.ty = ty;
  const [lx, ly] = lensTarget(tx, ty);
  L.lx.set(lx);
  L.ly.set(ly);
  els.app.classList.toggle('is-read-low', L.on && ly < 190);
  els.lensRead.style.bottom =
    L.on && els.app.classList.contains('is-zcarding') ? `${els.zcard.offsetHeight + 24}px` : '';
  if (!L.armed && (ty >= EDGE_BAND || L.engY - ty > 20)) L.armed = true;
  if (L.armed && !L.sticky && ty < EDGE_BAND) edgeScroll();
  const piece = Math.max(pieceSize(cam.s), 12);
  const [i, d] = nearestItem(tx, ty, Math.max(piece * 0.9, 18));
  const { px, py } = F.layout;
  if (i >= 0 && isShown(i) && d < piece * 0.7) {
    L.fx.set(tx + (sx(px[i]!) - tx) * 0.65);
    L.fy.set(ty + (sy(py[i]!) - ty) * 0.65);
  } else {
    L.fx.set(tx);
    L.fy.set(ty);
  }
  els.touchDot.style.transform = `translate3d(${tx}px,${ty}px,0)`;
  const near = i >= 0 && isShown(i) && (!fActive() || filter.matchSet.has(i)) && d < Math.max(piece * 0.6, 14);
  if (i !== L.sel || near !== L.near) {
    const changed = i !== L.sel;
    L.sel = i;
    L.near = near;
    onSelect(i, changed);
  }
  flags.lensDirty = true;
  kick();
}

/** The readout lives in the header, or in a pill above the dock while the
 *  lens covers the header. */
export function setReadout(name: string, meta: string, opts: { muted?: boolean; rare?: boolean } = {}): void {
  for (const el of [els.roName, els.lrName]) {
    el.textContent = name;
    el.classList.toggle('is-muted', Boolean(opts.muted));
    if (opts.rare) {
      const d = document.createElement('span');
      d.className = 'grid-hdot';
      el.appendChild(d);
    }
  }
  els.roMeta.textContent = meta || ' ';
  els.lrMeta.textContent = meta || ' ';
}

function onSelect(i: number, changed: boolean): void {
  const shown = i >= 0 && isShown(i);
  L.selShown = shown;
  if (i < 0) {
    const a = F.layout.areas[areaAt(wx(L.tx), wy(L.ty))];
    els.engTop.textContent = a ? (F.layout.regions[a.region]?.name ?? '') : '';
    els.engBot.textContent = '';
    setReadout(a ? areaPlace(a) : ' ', '', { muted: true });
    return;
  }
  const a = areaOfI(i);
  const cell = F.layout.cells[i];
  if (!a || !cell) return;
  els.engTop.textContent = F.layout.regions[a.region]?.name ?? '';
  els.engBot.textContent = cell.no ? `No. ${cell.no} of ${cell.of ?? cell.no}` : '';
  const letGo = L.near && !L.sticky ? ' · Let go to open' : '';
  if (shown) {
    const when = foundAt(i);
    setReadout(nameOf(i), `${when ? `Found ${shortDate(when)}` : placeOf(i)}${letGo}`, { rare: isRare(i) });
  } else
    setReadout('Not found yet', `${placeOf(i)}${cell.no ? ` · No. ${cell.no}` : ''}`, {
      muted: true,
      rare: isRare(i),
    });
  if (changed) haptic('tick');
  if (shown) wantArt(ownUrl(i), 50);
}

/** Lower the lens. 'now' hides it at once; 'release' fades and shrinks it to
 *  90% over 160 ms while the piece lifts out of it. */
export function closeLoupe(how?: 'now' | 'release'): void {
  if (!L.on) return;
  const wasLayer = L.sticky && !L.auto;
  L.on = false;
  L.sticky = false;
  L.auto = false;
  L.near = false;
  setTickMute(false);
  if (wasLayer) syncHistory();
  els.app.classList.remove('is-read-low');
  els.touchDot.classList.remove('is-on');
  els.head.classList.remove('is-reading');
  if (how === 'now') {
    L.sc.snap(0);
    els.loupe.classList.remove('is-on');
  } else if (how === 'release') {
    L.sc.set(0.9);
    const a = els.loupe.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: motion.reduced ? 1 : 160,
      easing: 'ease-out',
      fill: 'forwards',
    });
    L.fade = a;
    a.finished
      .then(() => {
        if (L.fade !== a) return;
        L.fade = null;
        L.sc.snap(0);
        els.loupe.classList.remove('is-on');
        a.cancel();
      })
      .catch(() => undefined);
  } else if (motion.reduced) {
    L.sc.snap(0);
    els.loupe.classList.remove('is-on');
  } else L.sc.set(0);
  kick();
}

/** Where cell i sits inside the lens right now, so opening it lifts it out of
 *  the glass. */
export function lensSpot(i: number): { x: number; y: number; s: number } {
  const s = L.sc.x;
  const g = lensGain();
  const { px, py } = F.layout;
  const f = fish((sx(px[i]!) - L.fx.x) * g, (sy(py[i]!) - L.fy.x) * g, 66, 110, 1.15);
  return {
    x: L.lx.x + f.x * s,
    y: L.ly.x + (1 - s) * 60 + f.y * s,
    s: Math.min(132, Math.max(pieceSize(cellSize(i)) * g, 12) * f.s) * s,
  };
}

/** How much more the lens magnifies than its glass, so a piece shows at least
 *  as big as at six across. */
const lensGain = (): number => Math.max(1, lensPieceSide(view.W) / cam.s);

export function placeLoupe(): void {
  const s = L.sc.x;
  if (s < 0.02 && !L.on) {
    els.loupe.classList.remove('is-on');
    return;
  }
  els.loupe.style.transform = `translate3d(${L.lx.x - 126}px,${L.ly.x - 126 + (1 - s) * 60}px,0) scale(${Math.max(0.01, s)})`;
}

export function renderLens(): void {
  const c = els.lens.getContext('2d')!;
  const ld = L.ld;
  c.setTransform(ld, 0, 0, ld, 0, 0);
  c.fillStyle = tok.lens;
  c.fillRect(0, 0, 220, 220);
  const fx = L.fx.x;
  const fy = L.fy.x;
  const RL = 110;
  const RF = 66;
  const K = 1.15;
  // Out at the dots the glass alone would show dots: the field under it is
  // taken in smaller and drawn bigger, to the size pieces have at six across.
  const g = lensGain();
  // Each cell at its own size: a folded dot is smaller than a piece's cell.
  const pieceOf = (i: number): number => Math.max(pieceSize(cellSize(i)) * g, 12);
  const dotOf = (i: number): number => Math.max(1.3, Math.min(cellSize(i) * g, 21) * 0.095);
  const rot = tilt.x.x * 40;
  const own: [number, ReturnType<typeof fish>][] = [];
  const w0 = wx(fx);
  const w1 = wy(fy);
  const R = (RF * 1.2) / (cam.s * g) + 1;
  const { areas, px, py } = F.layout;
  for (const a of areas) {
    if (w0 < a.x - R || w0 > a.x + a.w + R || w1 < a.y - R || w1 > a.y + a.h + R) continue;
    for (let i = a.from; i < a.to; i++) {
      const dx = (sx(px[i]!) - fx) * g;
      const dy = (sy(py[i]!) - fy) * g;
      if (Math.abs(dx) > RF * 1.3 || Math.abs(dy) > RF * 1.3) continue;
      const f = fish(dx, dy, RF, RL, K);
      if (f.d > RF * 1.15) continue;
      if (isShown(i)) {
        own.push([i, f]);
        continue;
      }
      const lx = 110 + f.x;
      const ly = 110 + f.y;
      if (f.d < RF * 0.85) {
        const url = catUrl(i);
        wantArt(url, 1);
        const sil = artSilhouette(url, tok.sil);
        if (sil) {
          const sz = Math.min(124, pieceOf(i) * f.s) * 0.9;
          c.globalAlpha = tok.sila * (1 - f.d / (RF * 0.85)) * (i === L.sel ? 2.2 : 1);
          c.drawImage(sil, lx - sz / 2, ly - sz / 2, sz, sz);
        }
      }
      c.globalAlpha = 1;
      c.fillStyle = tok.lensdot;
      c.beginPath();
      c.arc(lx, ly, dotOf(i) * f.s * 0.9, 0, 6.2832);
      c.fill();
    }
  }
  own.sort((a, b) => a[1].y - b[1].y);
  for (const [i, f] of own) {
    if (F.detailI === i) continue;
    const sz = Math.min(132, pieceOf(i) * f.s);
    const lx = 110 + f.x;
    const ly = 110 + f.y;
    const al = fActive() && !filter.matchSet.has(i) ? 0.15 : 1;
    const url = ownUrl(i);
    const art = artCell(url);
    if (sz < 9) {
      c.globalAlpha = al;
      c.fillStyle = art?.color ?? tok.fg3;
      c.beginPath();
      c.arc(lx, ly, sz * 0.3, 0, 6.2832);
      c.fill();
      continue;
    }
    c.globalAlpha = tok.shadowa * 0.8 * al;
    c.drawImage(shadowBlob(), lx - sz * 0.36, ly + sz * (0.5 - (art?.gap ?? 0.05)) - sz * 0.05, sz * 0.72, sz * 0.13);
    if (isRare(i)) drawHalo(c, lx, ly, sz * 0.62, rot, tok.haloa * al);
    c.globalAlpha = al;
    const big = sz * ld > CELL * 1.2 ? artBig(url) : undefined;
    if (big) c.drawImage(big, lx - sz / 2, ly - sz / 2, sz, sz);
    else if (art) c.drawImage(art.page, art.sx, art.sy, CELL, CELL, lx - sz / 2, ly - sz / 2, sz, sz);
  }
  c.globalAlpha = 1;
}
