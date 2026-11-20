// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// Pointers on the grid: scroll, pinch between steps, hold for the lens (450 ms,
// 8 px slack, a ring filling from 150 ms), tap and double tap. A touch on a
// moving grid only stops it. A pinch keeps the piece under the fingers in place
// and, when the first finger lifts, settles on the nearest step, or the next
// one if still moving fast.
// Overscroll is engine/edges.ts.

import { DEFAULT_STEP, restingStep } from '../model/grid';
import { pieceSize } from '../model/grid';
import { camMoved, camState, fitAll, scrollTo, settleBounds, stopCam, zoomStep, zoomTo } from './camera';
import { cam, els, F, filter, grid, isShown, on, sx, sy, view } from './core';
import { detailOpen, openDetail, pageBy } from './detail';
import { dragBy, dragEnd, dragStart, holdEnds, touchDown, touchMove, wheelBy } from './edges';
import { fActive, resetFilter } from './filters';
import {
  type Anchor,
  anchorAt,
  folded,
  overFromPieceSide,
  pieceSideAt,
  placeGrid,
  restStep,
  stepCount,
  zFromPieceSide,
} from './grid';
import { haptic, primeHaptics } from './haptic';
import { closeTop } from './history';
import { closeLoupe, edgeActive, engageLoupe, lensSpot, lensState, moveLoupe, nearestItem } from './lens';
import { closeSearch, searchOpen } from './search';
import { sheetOpen } from './sheets';
import { toast } from './toast';

const HOLD_MS = 450;
const HOLD_SLOP = 8;
const RING_AT = 150;
/** Two fingers down and up within this, without moving, step out. */
const TWO_TAP_MS = 260;

interface Press {
  id: number;
  x0: number;
  y0: number;
  x: number;
  y: number;
  t0: number;
  mode: 'pan' | 'loupe' | null;
  stopOnly: boolean;
  dbl: boolean;
}

interface Pinch {
  d0: number;
  t0: number;
  an: Anchor;
  at: number;
  moved: boolean;
  cx: number;
  cy: number;
  /** Recent (time, step) pairs, for the pace when the fingers lift. */
  hist: [number, number][];
}

const ptrs = new Map<number, { x: number; y: number }>();
let press: Press | null = null;
let holdT = 0;
let ringT = 0;
let pinch: Pinch | null = null;
let lastTap: { t: number; x: number; y: number; timer: number } | null = null;

/** Whether a finger (or the mouse button) is down on the grid, or a trackpad
 *  pinch is still arriving. */
export const pointerActive = (): boolean => ptrs.size > 0 || wheelAn !== null;
let peekTipShown = false;
let wheelT = 0;
let wheelAn: Anchor | null = null;

const local = (e: PointerEvent | WheelEvent): [number, number] => [e.clientX - view.left, e.clientY - view.top];

function ringOff(): void {
  window.clearTimeout(ringT);
  els.holdRing.classList.remove('is-on');
  els.holdArc.getAnimations().forEach((a) => a.cancel());
}

/** Taps open your pieces at once; a double tap steps in. A tap near a dot you
 *  don't have waits out the double tap, then parks the lens on it. */
function tapAt(x: number, y: number, dbl: boolean): void {
  const piece = Math.max(pieceSize(cam.s), 14);
  const ready = F.intro === -1;
  if (dbl) {
    lastTap = null;
    closeLoupe();
    const last = restStep() >= stepCount() - 1;
    if (last) zoomTo(DEFAULT_STEP, anchorAt(x, y), 380);
    else zoomStep(x, y, 1);
    haptic('tick');
    return;
  }
  const [i] = nearestItem(x, y, Math.max(22, piece * 0.6), (j) => isShown(j) && (F.appear[j] ?? 1) > 0.5);
  if (i >= 0 && ready) {
    if (fActive() && !filter.matchSet.has(i)) {
      toast('Hidden by your filter', { label: 'Clear filter', fn: () => resetFilter() });
      return;
    }
    if (lastTap) {
      window.clearTimeout(lastTap.timer);
      lastTap = null;
    }
    haptic('medium');
    openDetail(i, { x: sx(F.layout.px[i]!), y: sy(F.layout.py[i]!), s: pieceSize(cam.s) });
    return;
  }
  const now = performance.now();
  // Where the missing pieces have gathered into dots, there is nothing to
  // look at closer.
  const [m] = folded() ? [-1] : nearestItem(x, y, Math.max(18, piece * 0.6), (j) => !isShown(j));
  if (m >= 0 && lensState.sticky) {
    peekMissing(m);
    lastTap = { t: now, x, y, timer: 0 };
    return;
  }
  if (m < 0) closeLoupe();
  // Held by key: the layout may move in the 300 ms the peek waits.
  const key = m >= 0 ? F.layout.cells[m]?.key : undefined;
  lastTap = {
    t: now,
    x,
    y,
    timer: key
      ? window.setTimeout(() => {
          lastTap = null;
          const j = F.layout.index.get(key);
          if (j !== undefined) peekMissing(j);
        }, 300)
      : 0,
  };
}

function peekMissing(i: number): void {
  const x = sx(F.layout.px[i]!);
  const y = sy(F.layout.py[i]!);
  if (lensState.sticky) moveLoupe(x, y);
  else engageLoupe(x, y, true);
  if (!peekTipShown) {
    peekTipShown = true;
    toast('Press and hold anywhere to look closer');
  }
}

function startPinch(now: number): void {
  const [a, b] = [...ptrs.values()] as [{ x: number; y: number }, { x: number; y: number }];
  const cx = (a.x + b.x) / 2;
  const cy = (a.y + b.y) / 2;
  pinch = {
    d0: Math.hypot(a.x - b.x, a.y - b.y),
    t0: pieceSideAt(grid.z),
    an: anchorAt(cx, cy),
    at: now,
    moved: false,
    cx,
    cy,
    hist: [[now, grid.z]],
  };
}

function movePinch(p: Pinch): void {
  const [a, b] = [...ptrs.values()] as [{ x: number; y: number }, { x: number; y: number }];
  const d = Math.hypot(a.x - b.x, a.y - b.y);
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  if (Math.abs(d - p.d0) > HOLD_SLOP || Math.hypot(mx - p.cx, my - p.cy) > HOLD_SLOP) p.moved = true;
  const t = (p.t0 * d) / Math.max(1, p.d0);
  grid.z = zFromPieceSide(t);
  // Past either end the grid gives a little about the fingers instead.
  grid.over = overFromPieceSide(t);
  grid.overX = mx;
  grid.overY = my;
  p.an.sy = my;
  placeGrid(p.an);
  // Past the grid's top or bottom the anchor holds at the end.
  holdEnds();
  camMoved();
  const now = performance.now();
  p.hist.push([now, grid.z]);
  while (p.hist.length > 2 && now - p.hist[0]![0] > 90) p.hist.shift();
}

/** A finger lifted: settle on the nearest step, or on the next while the
 *  pinch was still moving fast. */
function endPinch(p: Pinch): void {
  const first = p.hist[0]!;
  const last = p.hist[p.hist.length - 1]!;
  const dt = last[0] - first[0];
  const pace = dt > 0 ? ((last[1] - first[1]) / dt) * 1000 : 0;
  zoomTo(restingStep(grid.z, pace), p.an, 340);
}

function endPtr(e: PointerEvent, cancel: boolean): void {
  if (!ptrs.has(e.pointerId)) return;
  ptrs.delete(e.pointerId);
  if (pinch) {
    // The first finger up ends the pinch. The one still down does nothing more.
    if (ptrs.size < 2) {
      const p = pinch;
      pinch = null;
      if (!cancel && !p.moved && performance.now() - p.at < TWO_TAP_MS) zoomStep(p.cx, p.cy, -1);
      else endPinch(p);
    }
    return;
  }
  if (press?.id !== e.pointerId) return;
  window.clearTimeout(holdT);
  ringOff();
  const p = press;
  press = null;
  if (p.mode === 'loupe') {
    const L = lensState;
    if (!cancel && L.on && L.sel >= 0 && L.selShown && L.near) openDetail(L.sel, lensSpot(L.sel), true);
    else closeLoupe();
    return;
  }
  if (p.mode === 'pan') {
    if (!dragEnd(e.timeStamp)) settleBounds();
    return;
  }
  if (!cancel && !p.stopOnly) tapAt(p.x0, p.y0, p.dbl);
  // A touch that only stopped a moving grid may have left it between steps.
  else settleBounds();
}

export function attachGestures(): void {
  const fw = els.fieldWrap;
  on(fw, 'contextmenu', (e) => e.preventDefault());
  on(fw, 'pointerdown', (e) => {
    if (detailOpen()) return;
    // No compatibility mouse events after a touch: their mousedown would land
    // after a tap has opened a piece and pull focus out of it.
    if (e.pointerType === 'touch') e.preventDefault();
    primeHaptics();
    const [x, y] = local(e);
    ptrs.set(e.pointerId, { x, y });
    try {
      fw.setPointerCapture(e.pointerId);
    } catch {
      // released already
    }
    const moving =
      Boolean(camState.mom) || Boolean(camState.task) || edgeActive() || performance.now() - camState.lastMove < 100;
    // A fling still running passes what it would carry to this touch first.
    if (ptrs.size === 1) touchDown(y, e.timeStamp);
    stopCam();
    const now = performance.now();
    if (ptrs.size === 2) {
      window.clearTimeout(holdT);
      ringOff();
      if (lensState.on) closeLoupe('now');
      press = null;
      startPinch(now);
      return;
    }
    if (ptrs.size > 2) return;
    press = {
      id: e.pointerId,
      x0: x,
      y0: y,
      x,
      y,
      t0: now,
      mode: null,
      stopOnly: moving,
      dbl: false,
    };
    if (lastTap && now - lastTap.t < 300 && Math.hypot(x - lastTap.x, y - lastTap.y) < 60) {
      window.clearTimeout(lastTap.timer);
      press.dbl = true;
    } else if (lastTap) {
      // A new press somewhere else: the peek that was waiting gives way to it.
      window.clearTimeout(lastTap.timer);
      lastTap = null;
    }
    window.clearTimeout(holdT);
    ringOff();
    // Where the missing pieces have gathered into dots, a hold looks at nothing.
    if (folded()) return;
    holdT = window.setTimeout(() => {
      if (press && !press.mode) {
        ringOff();
        press.mode = 'loupe';
        engageLoupe(press.x, press.y);
      }
    }, HOLD_MS);
    ringT = window.setTimeout(() => {
      if (!press || press.mode) return;
      els.holdRing.style.transform = `translate3d(${press.x}px,${press.y}px,0)`;
      els.holdRing.classList.add('is-on');
      els.holdArc.animate([{ strokeDashoffset: 100 }, { strokeDashoffset: 0 }], {
        duration: HOLD_MS - RING_AT,
        easing: 'linear',
        fill: 'forwards',
      });
    }, RING_AT);
  });
  on(fw, 'pointermove', (e) => {
    // A mouse over a piece shows it can be opened.
    if (e.pointerType === 'mouse' && !ptrs.size) {
      const [hx, hy] = local(e);
      const [h] = nearestItem(hx, hy, Math.max(22, pieceSize(cam.s) * 0.6), (j) => isShown(j));
      fw.style.cursor = h >= 0 ? 'pointer' : '';
    }
    if (!ptrs.has(e.pointerId)) return;
    const [x, y] = local(e);
    ptrs.set(e.pointerId, { x, y });
    if (pinch && ptrs.size >= 2) {
      movePinch(pinch);
      return;
    }
    if (press?.id !== e.pointerId) return;
    touchMove(y, e.timeStamp);
    const dy = y - press.y;
    if (!press.mode && Math.hypot(x - press.x0, y - press.y0) > HOLD_SLOP) {
      press.mode = 'pan';
      window.clearTimeout(holdT);
      ringOff();
      if (lensState.sticky) closeLoupe();
      dragStart();
    }
    if (press.mode === 'pan') dragBy(dy);
    else if (press.mode === 'loupe') moveLoupe(x, y);
    press.x = x;
    press.y = y;
  });
  on(fw, 'pointerup', (e) => endPtr(e, false));
  on(fw, 'pointercancel', (e) => endPtr(e, true));
  on(
    fw,
    'wheel',
    (e) => {
      e.preventDefault();
      const [x, y] = local(e);
      // A trackpad pinch arrives as a wheel with ctrl held.
      if (e.ctrlKey || e.metaKey) {
        stopCam();
        wheelAn ??= anchorAt(x, y);
        wheelAn.sy = y;
        const t = pieceSideAt(grid.z) * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.004));
        grid.z = zFromPieceSide(t);
        grid.over = overFromPieceSide(t);
        grid.overX = x;
        grid.overY = y;
        placeGrid(wheelAn);
        camMoved();
        window.clearTimeout(wheelT);
        wheelT = window.setTimeout(() => {
          const an = wheelAn;
          wheelAn = null;
          zoomTo(restingStep(grid.z), an, 300);
        }, 160);
        return;
      }
      stopCam();
      wheelBy(e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY, performance.now());
      window.clearTimeout(wheelT);
      wheelT = window.setTimeout(settleBounds, 140);
    },
    { passive: false },
  );
  const zIn = els.app.querySelector<HTMLElement>('[data-act="zoom-in"]');
  const zOut = els.app.querySelector<HTMLElement>('[data-act="zoom-out"]');
  if (zIn) on(zIn, 'click', () => zoomStep(view.W / 2, view.H / 2, 1));
  if (zOut) on(zOut, 'click', () => zoomStep(view.W / 2, view.H / 2, -1));
  on(document, 'keydown', (e) => {
    if (e.target === els.sInput) {
      if (e.key === 'Escape') closeSearch();
      return;
    }
    if (e.target instanceof Element && e.target.closest('input, textarea, [contenteditable]')) return;
    if (!els.app.isConnected) return;
    if (e.key === 'Escape') closeTop();
    if (detailOpen()) {
      if (e.key === 'ArrowRight') pageBy(1);
      if (e.key === 'ArrowLeft') pageBy(-1);
      return;
    }
    if (sheetOpen() || searchOpen() || e.metaKey || e.ctrlKey || e.altKey) return;
    // The list of pieces moves along itself with the arrows.
    if (e.target instanceof Element && e.target.closest('[data-el="pieceList"]')) return;
    if (e.key === '+' || e.key === '=') zoomStep(view.W / 2, view.H / 2, 1);
    if (e.key === '-') zoomStep(view.W / 2, view.H / 2, -1);
    if (e.key === '0') fitAll();
    const k = ({ ArrowDown: 1, ArrowUp: -1 } as Record<string, number>)[e.key];
    if (k) {
      e.preventDefault();
      scrollTo(cam.y + (k * 120) / cam.s, 220, null, 'out');
    }
  });
}

/** Clears any gesture in progress (the engine is detaching or restarting). */
export function resetGestures(): void {
  ptrs.clear();
  press = null;
  pinch = null;
  wheelAn = null;
  window.clearTimeout(holdT);
  window.clearTimeout(ringT);
  window.clearTimeout(wheelT);
  if (lastTap) window.clearTimeout(lastTap.timer);
  lastTap = null;
}
