// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// The grid engine's surface: attach it to the elements GridScreen renders, pass
// it each new field, detach on unmount. Everything that moves per frame lives
// behind this; React draws the screen once and the app's own overlays.

import type { OpenTarget } from '@/shared/lib/location';

import { keptArtBack, onArtChange } from '../art';
import type { FieldLayout, PieceState } from '../model/field';
import { spanOf } from '../model/filter';
import { cancelArrival, hasArrived, pillTapped, planArrival } from './arrival';
import { camBounds, camMoved, fitAll, framePiece, stopCam } from './camera';
import {
  cam,
  type Els,
  els,
  F,
  filter,
  flags,
  grid,
  isNewP,
  isOwned,
  isShown,
  kick,
  loop,
  motion,
  on,
  onCleanup,
  readTokens,
  setEls,
  setFrame,
  sx,
  sy,
  tasks,
  TOPI,
  unbindAll,
  view,
} from './core';
import { attachDetail, closeDetail, DT, fitPeek, refreshDetail, setExpanded } from './detail';
import { resetEdges } from './edges';
import { attachFilters, openNew, recomputeMatches, updateNewBtn } from './filters';
import { attachFocus } from './focus';
import { frame } from './frame';
import { attachGestures, resetGestures } from './gestures';
import { type Anchor, anchorAt, placeGrid, rebuildGrid, savedStep } from './grid';
import { freezeCount, updateHeader } from './header';
import { attachHint, hideHint, scheduleHint } from './hint';
import { attachHistory, releaseHistory } from './history';
import { type GridHooks, hooks, setHooks } from './hooks';
import { closeLoupe, lensState, resetEdge } from './lens';
import { attachPieceList, buildPieceList } from './plist';
import { INTRO_MS, refreshCounts } from './render';
import { attachSearch, renderResults, searchOpen } from './search';
import { attachSeen, debugSeen, detachSeen } from './seen';
import { attachSheets, buildCollList, resetSheets } from './sheets';
import { redrawThumbs } from './thumbs';
import { attachTilt } from './tilt';
import { clamp } from './util';
import { restartEmptyShow, zeroEnd, zeroLook, zeroStart } from './zero';

/** A field as the app passes it over. */
export interface FieldInput {
  layout: FieldLayout;
  pieces: PieceState[];
  /** Whether newness is known: the engine waits for it before its first
   *  move, so pieces new since last time can arrive rather than just be there. */
  ready: boolean;
  /** This device had no record of what the player has seen: everything
   *  arrives, but is called their first pieces only if it all came in the last 24 hours. */
  firstRecord?: boolean;
  /** The field is what this device kept from the last visit, before this
   *  session's reads: it opens at once, with no reveal. */
  kept?: boolean;
}

/** Pieces that just became the player's while the grid was up. */
export interface ArrivalHint {
  hashes: string[];
}

/** Orbs for `idx`: one per new copy, so two copies of a piece fly twice. */
function orbKeys(idx: readonly number[]): string[] {
  const out: string[] = [];
  for (const i of idx) {
    const key = F.layout.cells[i]!.key;
    for (let k = 0; k < Math.max(1, F.pieces[i]!.newCopies); k++) out.push(key);
  }
  return out;
}

const pieceWord = (n: number): string => (n === 1 ? 'piece' : 'pieces');

/** The engine's own copy of a layout's geometry: the grid rewrites the
 *  positions as it moves, and the copy the app built stays as it was. */
function ownLayout(l: FieldLayout): FieldLayout {
  return {
    ...l,
    px: new Float32Array(l.px),
    py: new Float32Array(l.py),
    areas: l.areas.map((a) => ({ ...a })),
    regions: l.regions.map((r) => ({ ...r })),
  };
}

let pending: FieldInput | null = null;
/** The boot's own timers (the wait for saved pictures, the first arrival, the
 *  focus pulse), cleared on detach. */
const bootTimers: number[] = [];
let resize: ResizeObserver | null = null;
let rmQuery: MediaQueryList | null = null;
let fontsReady = false;
/** The small pictures kept from earlier opens are back on the atlas (art.ts). */
let keptArtIn = false;
/** A kept field has waited as long as it waits for the fonts and its pictures. */
let keptWaitOver = false;
/** How long a kept field waits for fonts and kept pictures, well inside the
 *  0.35 s before the boot line shows (grid.css). */
const KEPT_WAIT_MS = 150;

/** Size the canvases to the app and lay the grid out for its width. What was
 *  in the middle of the view stays there, unless `an` sets what to keep. */
function layoutView(an?: Anchor | null): void {
  if (!flags.attached) return;
  const keep = an !== undefined ? an : flags.booted && grid.layouts.length ? anchorAt(view.W / 2, view.H / 2) : null;
  const r = els.app.getBoundingClientRect();
  view.W = r.width;
  view.H = r.height;
  view.left = r.left;
  view.top = r.top;
  view.dpr = Math.min(window.devicePixelRatio || 1, 2);
  const { W, H, dpr } = view;
  els.field.width = Math.round(W * dpr);
  els.field.height = Math.round(H * dpr);
  els.field.style.width = `${W}px`;
  els.field.style.height = `${H}px`;
  const ld = Math.min(window.devicePixelRatio || 1, 2.5);
  els.lens.width = els.lens.height = Math.round(220 * ld);
  lensState.ld = ld;
  rebuildGrid(keep);
  // Detail sizes: peek is about 40% of the screen; expanded puts the sheet's
  // top about 240 px down and scales the stage to fit above it.
  const land = W > H * 1.05;
  DT.land = land;
  els.app.classList.toggle('is-land', land);
  const peekH = clamp(H * 0.4, 300, 340);
  const expTop = clamp(H * 0.31, 200, 260);
  const full = H - expTop;
  const stageH = land ? H - 60 : H - 60 - peekH;
  const stageW = land ? W / 2 : W;
  const ps = Math.round(clamp(Math.min(stageW * 0.7, stageH * 0.78), 140, 300));
  DT.geo = { off: full - peekH, k: clamp((expTop - 60) / stageH, 0.3, 1), peekH, stageH };
  const vars: [string, string][] = [
    ['--sheet-h', `${peekH}px`],
    ['--sheet-full', `${full}px`],
    ['--sheet-off', `${DT.geo.off}px`],
    ['--exp-k', DT.geo.k.toFixed(3)],
    ['--ps', `${ps}px`],
    ['--tt-w', `${Math.round(ps * 0.92)}px`],
  ];
  for (const [k, v] of vars) els.app.style.setProperty(k, v);
  if (land) setExpanded(false);
  fitPeek();
  fitDock();
  flags.dirty = true;
  // Sizing the lens canvas cleared it.
  flags.lensDirty = true;
  kick();
}

/** Large text: when a dock label would be cut, the icons go, so the words
 *  have the room. */
function fitDock(): void {
  els.dock.classList.remove('is-tight');
  const cut = [...els.dock.querySelectorAll<HTMLElement>('.grid-dockbtn span:not(.grid-sr)')].some(
    (s) => s.scrollWidth > s.clientWidth + 1,
  );
  els.dock.classList.toggle('is-tight', cut);
}

/** Opens on the step this device last rested on, showing the pieces a link
 *  asked for, else the first new to this device, else the newest. */
function homeView(toward: readonly number[]): void {
  stopCam();
  grid.z = savedStep();
  placeGrid(null);
  const owned: number[] = [];
  for (let i = 0; i < F.pieces.length; i++) if (isOwned(i)) owned.push(i);
  if (!owned.length) {
    cam.y = camBounds().y0;
    camMoved();
    return;
  }
  const { py } = F.layout;
  const fresh = toward.length ? [...toward] : owned.filter((i) => F.pieces[i]!.newCopies > 0);
  const target = fresh.length
    ? fresh.reduce((a, b) => (py[b]! < py[a]! ? b : a))
    : owned.reduce((a, b) => ((F.pieces[b]!.foundAt ?? 0) > (F.pieces[a]!.foundAt ?? 0) ? b : a));
  cam.y = framePiece(target);
  camMoved();
}

const onScreen = (i: number): boolean => {
  const x = sx(F.layout.px[i]!);
  const y = sy(F.layout.py[i]!);
  return x > 0 && x < view.W && y > TOPI && y < view.H - 190;
};

function setControlsLive(on: boolean): void {
  els.dock.inert = !on;
  const search = els.app.querySelector<HTMLElement>('[data-act="search"]');
  if (search) search.inert = !on;
}

/** The first move, once the field, the fonts and newness are all in. */
function boot(): void {
  flags.booted = true;
  setControlsLive(true);
  buildPieceList();
  const be = els.boot;
  const o = Number(getComputedStyle(be).opacity);
  be.style.animation = 'none';
  be.style.opacity = '0';
  if (o > 0.01) be.animate([{ opacity: o }, { opacity: 0 }], { duration: 200, easing: 'ease-out' });
  // A kept field is simply there; a field read this session is revealed.
  const reveal = !motion.reduced && !pending?.kept;
  F.intro = reveal ? -2 : -1;
  // A link that named New: the view is set before anything is drawn, so the
  // first frame is New, framed on its pieces, and no frame comes before it.
  const target = flags.target;
  flags.target = null;
  const toNew = target?.open === 'new';
  // Pieces in New this device has not seen fly in; a new copy of a piece held
  // before flies in too, without hiding the piece first.
  const fresh: number[] = [];
  let owned = 0;
  for (let i = 0; i < F.pieces.length; i++)
    if (F.pieces[i]!.status === 'owned') {
      owned++;
      const unseen = F.pieces[i]!.newCopies > 0 && !hasArrived(F.layout.cells[i]!.key);
      if (unseen && isNewP(i)) fresh.push(i);
    }
  fresh.sort((a, b) => (F.pieces[a]!.foundAt ?? 0) - (F.pieces[b]!.foundAt ?? 0));
  const allNew = (i: number): boolean => F.pieces[i]!.newCopies >= F.pieces[i]!.copies;
  const hold = fresh.filter(allNew).map((i) => F.layout.cells[i]!.key);
  const first = fresh.length > 0 && fresh.length === owned && fresh.every(allNew);
  for (const k of hold) F.held.add(k);
  refreshCounts();
  // An empty grid opens as it always does; its first pieces are the event.
  if (toNew && F.foundCount > 0) openNew();
  recomputeMatches();
  updateHeader(false);
  if (first) {
    els.countLine.textContent = '\u00a0';
    freezeCount(true);
  }
  homeView(toNew ? filter.matches : []);
  let newest = -1;
  for (let i = 0; i < F.pieces.length; i++)
    if (isShown(i) && (newest < 0 || (F.pieces[i]!.foundAt ?? 0) > (F.pieces[newest]!.foundAt ?? 0))) newest = i;
  F.introX = view.W / 2;
  F.introY = view.H / 2;
  if (newest >= 0 && onScreen(newest)) {
    F.introX = sx(F.layout.px[newest]!);
    F.introY = sy(F.layout.py[newest]!);
  }
  F.introR = Math.max(
    ...[
      [0, 0],
      [view.W, 0],
      [0, view.H],
      [view.W, view.H],
    ].map(([x, y]) => Math.hypot(x! - F.introX, y! - F.introY)),
  );
  flags.dirty = true;
  kick();
  if (fresh.length) {
    const keys = orbKeys(fresh);
    const n = keys.length;
    // With no record on this device, "first" is shown only for pieces that all
    // came in the last day: a new phone is not a first game.
    const day = Date.now() / 1000 - 86_400;
    const recent = fresh.every((i) => (F.pieces[i]!.foundAt ?? 0) > day);
    const title = !first
      ? `${n} new ${pieceWord(n)}`
      : pending?.firstRecord && !recent
        ? 'Here’s your collection'
        : `Your first ${n} ${pieceWord(n)}`;
    // A first collection, and new pieces on a kept field, arrive straight
    // away; new pieces for a returning player wait for the reveal to finish
    // before the camera moves.
    bootTimers.push(
      window.setTimeout(
        () => planArrival({ keys, hold, title, first }),
        motion.reduced ? 0 : first || !reveal ? 500 : INTRO_MS + 50,
      ),
    );
  } else if (!F.foundCount) zeroStart();
  else {
    bootTimers.push(
      window.setTimeout(
        () => {
          F.focusI = newest;
          F.focusT = performance.now();
          kick();
        },
        motion.reduced ? 10 : 700,
      ),
    );
    scheduleHint();
  }
  hooks.opened(pending?.kept === true, target?.open ?? null);
}

function tryBoot(): void {
  if (flags.booted || !flags.attached || !pending?.ready) return;
  // A kept field opens once the fonts and its kept pictures are in, or after
  // KEPT_WAIT_MS without them; a field read this session waits for the fonts.
  if (!(pending.kept ? (fontsReady && keptArtIn) || keptWaitOver : fontsReady)) return;
  boot();
}

function apply(next: FieldInput, hints: readonly ArrivalHint[] = []): void {
  const prevKey = F.layout.key;
  const prevOwned = new Set<string>();
  for (let i = 0; i < F.pieces.length; i++) if (F.pieces[i]!.status === 'owned') prevOwned.add(F.layout.cells[i]!.key);
  const keyOf = (i: number): string => F.layout.cells[i]!.key;
  const flashByKey = new Map<string, number>();
  for (const [i, t] of F.flash) flashByKey.set(keyOf(i), t);
  const detailKey = DT.open && !DT.closing ? keyOf(DT.i) : null;
  // A piece open in the detail that the new field no longer has closes while
  // the old field is still in place, so the close reads its own piece.
  if (detailKey && next.layout.key !== prevKey && !next.layout.index.has(detailKey)) closeDetail(true);
  // What is in the middle of the view stays there through the new field.
  const keep = flags.booted && grid.layouts.length ? anchorAt(view.W / 2, view.H / 2) : null;
  F.layout = ownLayout(next.layout);
  F.pieces = next.pieces;
  F.span = spanOf(next.pieces);
  if (next.ready && next.kept !== true) flags.chainField = true;
  if (next.layout.key !== prevKey) {
    F.appear = new Float32Array(next.layout.cells.length).fill(1);
    F.flash = new Map();
    for (const [k, t] of flashByKey) {
      const i = next.layout.index.get(k);
      if (i !== undefined) F.flash.set(i, t);
    }
    F.burst = new Map();
    F.focusI = -1;
    if (detailKey && DT.open && !DT.closing) {
      const i = next.layout.index.get(detailKey);
      if (i !== undefined) {
        DT.i = i;
        F.detailI = i;
      }
    }
    for (const k of [...F.held]) if (!next.layout.index.has(k)) F.held.delete(k);
    // The lens names a cell by index: after a move it would name another.
    if (lensState.on && !lensState.auto) closeLoupe('now');
    layoutView(keep);
    // What was in the middle may be gone from the new field: the view stays inside it.
    cam.y = clamp(cam.y, camBounds().y0, camBounds().y1);
    restartEmptyShow();
  } else rebuildGrid(keep);
  if (!flags.booted) {
    tryBoot();
    return;
  }
  // Pieces that just arrived while the grid was up: one orb per copy. A piece
  // new to the player stays hidden until its orb lands; a new copy of one
  // already on the grid flies to it.
  for (const hint of hints) {
    const keys: string[] = [];
    const hold: string[] = [];
    for (const h of hint.hashes) {
      const i = F.pieces.findIndex((p) => p.entries.some((e) => e.hash === h));
      if (i < 0) continue;
      const key = keyOf(i);
      keys.push(key);
      if (!prevOwned.has(key) && !hold.includes(key)) hold.push(key);
    }
    if (!keys.length) continue;
    const n = keys.length;
    planArrival({ keys, hold, title: `${n} new ${pieceWord(n)}` });
  }
  refreshCounts();
  if (F.foundCount > 0) zeroEnd();
  recomputeMatches();
  updateHeader(true);
  refreshDetail();
  buildPieceList();
  if (searchOpen()) renderResults(els.sInput.value);
  if (els.collSheet.classList.contains('is-open')) buildCollList();
  flags.dirty = true;
  flags.lensDirty = true;
  kick();
}

/** The screen a link asked the app to open on; the first frame takes it. */
export function setOpenTarget(target: OpenTarget | null): void {
  flags.target = target;
}

/** Pass the engine a new field, with the arrivals it brings. */
export function setGridField(next: FieldInput, hints: readonly ArrivalHint[] = []): void {
  pending = next;
  if (flags.attached) apply(next, hints);
}

export function attachGrid(next: Els, appHooks: Partial<GridHooks>): void {
  if (flags.attached) detachGrid();
  setEls(next);
  setHooks(appHooks);
  flags.attached = true;
  readTokens();
  rmQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  motion.reduced = rmQuery.matches;
  const onRm = (e: MediaQueryListEvent): void => {
    motion.reduced = e.matches;
  };
  rmQuery.addEventListener('change', onRm);
  onCleanup(() => rmQuery?.removeEventListener('change', onRm));
  setFrame(frame);
  onArtChange(() => {
    flags.dirty = true;
    flags.lensDirty = true;
    redrawThumbs();
    kick();
  });
  // The dock and search wait for the field: nothing to find before it opens.
  setControlsLive(false);
  resetSheets();
  attachFocus();
  attachPieceList();
  resetEdges();
  attachGestures();
  attachDetail();
  attachFilters();
  attachSeen(updateNewBtn);
  attachSheets();
  attachSearch();
  attachHint();
  attachTilt();
  attachHistory();
  on(els.pill, 'click', pillTapped);
  const look = els.zcard.querySelector<HTMLElement>('[data-act="look"]');
  if (look) on(look, 'click', zeroLook);
  on(document, 'visibilitychange', () => {
    if (!document.hidden) kick();
  });
  resize = new ResizeObserver(() => layoutView());
  resize.observe(els.app);
  layoutView();
  keptWaitOver = false;
  bootTimers.push(
    window.setTimeout(() => {
      keptWaitOver = true;
      tryBoot();
    }, KEPT_WAIT_MS),
  );
  void keptArtBack.then(() => {
    keptArtIn = true;
    tryBoot();
  });
  // The field opens once the fonts are in, or after 600 ms without them; a
  // face landing later redraws the canvas labels and refits the dock.
  void Promise.race([document.fonts.ready as Promise<unknown>, new Promise((r) => window.setTimeout(r, 600))]).then(
    () => {
      fontsReady = true;
      fitDock();
      flags.dirty = true;
      tryBoot();
    },
  );
  const onFonts = (): void => {
    fitDock();
    flags.dirty = true;
    kick();
  };
  document.fonts.addEventListener('loadingdone', onFonts);
  onCleanup(() => document.fonts.removeEventListener('loadingdone', onFonts));
  if (pending) apply(pending);
  if (import.meta.env.DEV) {
    (window as unknown as { __STASH_GRID__: unknown }).__STASH_GRID__ = {
      get booted() {
        return flags.booted;
      },
      cam,
      F,
      DT,
      lens: lensState,
      view,
      spot: (i: number) => ({ x: sx(F.layout.px[i]!), y: sy(F.layout.py[i]!) }),
      isOwned,
      isShown,
      grid,
      fitAll: () => fitAll(),
      seen: debugSeen,
      // One frame by hand, for a page whose animation frames do not run.
      step: (now: number) => frame(now),
    };
  }
}

export function detachGrid(): void {
  if (!flags.attached) return;
  flags.attached = false;
  flags.booted = false;
  flags.chainField = false;
  if (loop.raf) cancelAnimationFrame(loop.raf);
  loop.raf = 0;
  for (const t of bootTimers.splice(0)) window.clearTimeout(t);
  resize?.disconnect();
  resize = null;
  stopCam();
  resetEdge();
  cancelArrival();
  detachSeen();
  zeroEnd();
  hideHint();
  closeLoupe('now');
  resetGestures();
  tasks.clear();
  els.detail.classList.remove('is-open', 'is-floating', 'is-expanded');
  els.app.classList.remove('is-detailing');
  DT.open = false;
  DT.busy = false;
  DT.phase = '';
  F.detailI = -1;
  releaseHistory();
  unbindAll();
}
