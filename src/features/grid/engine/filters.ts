// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// The filter: Found or Missing, Rare, New and a date range drawn as a chart of
// finds per day. Matching pieces stay lit on the field and the rest dim; a
// step bar walks the matches one at a time.

import { dateOfDay, monthName } from '../model/days';
import { shortDate } from '../model/days';
import {
  criteriaCount,
  type Filter,
  filterActive,
  filterLabel,
  foundDay,
  fullRange,
  hasHistory,
  matchAll,
  NO_FILTER,
  onlyNew as onlyNewOf,
  rangeLabel,
} from '../model/filter';
import { fitRows, framePiece, scrollTo } from './camera';
import {
  areaOfI,
  cam,
  els,
  F,
  filter,
  flags,
  foundAt,
  isNewP,
  isOwned,
  isRare,
  isShown,
  kick,
  motion,
  nameOf,
  on,
  placeOf,
  type Task,
  tasks,
  view,
  wx,
} from './core';
import { haptic } from './haptic';
import { lensState, setReadout } from './lens';
import { refreshUnseen, unseenCount } from './seen';
import { closeSheets, filtOpen } from './sheets';
import { toast } from './toast';
import { clamp, holo, roundRect, UI_FONT } from './util';

export const fActive = (): boolean => filterActive(filter.f, F.span);
export const onlyNew = (): boolean => onlyNewOf(filter.f, F.span);
const full = (): boolean => fullRange(filter.f, F.span);
const last = (): number => F.span.last;
/** The view the New button opens: found pieces that arrived in the last 12 hours. */
const NEW_VIEW: Filter = { ...NO_FILTER, show: 'found', isNew: true };

/** Recount the matches, and every control that shows them. */
export function recomputeMatches(): void {
  const f = filter.f;
  filter.matches = matchAll(f, F.span, F.layout, F.pieces).filter((i) => !F.held.has(F.layout.cells[i]!.key));
  filter.matchSet = new Set(filter.matches);
  filter.stepIdx = -1;
  F.areaMatch.fill(0);
  for (const i of filter.matches) F.areaMatch[F.layout.areaOf[i]!]! += 1;
  const active = fActive();
  const n = filter.matches.length;
  els.fFit.textContent = !active ? 'Done' : n ? `Show ${n}` : 'No matches';
  els.fFit.disabled = active && !n;
  const fOn = active && !onlyNew();
  els.filtLbl.textContent = fOn ? `Filter · ${criteriaCount(f, F.span)}` : 'Filter';
  els.bFilter.classList.toggle('is-on', fOn);
  updateNewBtn();
  els.stepbar.classList.toggle('is-show', active);
  els.app.classList.toggle('is-filtering', active);
  els.stepName.textContent = filterLabel(f, F.span);
  els.stepPos.textContent = n ? `${n} ${n === 1 ? 'piece' : 'pieces'}` : emptyLabel();
  flags.dirty = true;
  kick();
}

/** The New button: pressed while New is the view, its dot lit while New
 *  holds something the player has not seen (seen.ts). */
export function updateNewBtn(): void {
  refreshUnseen();
  const unseen = unseenCount();
  const on = filter.f.isNew;
  els.bNew.classList.toggle('is-on', on);
  els.bNew.setAttribute('aria-pressed', String(on));
  els.nDot.classList.toggle('is-on', unseen > 0);
  els.bNew.setAttribute('aria-label', unseen > 0 ? `New, ${unseen} unseen` : 'New');
}

export function toggleNew(): void {
  const turnOn = !onlyNew();
  if (turnOn && !F.pieces.some((_, i) => isNewP(i))) {
    toast('Nothing new');
    return;
  }
  filter.f = turnOn ? { ...NEW_VIEW } : { ...NO_FILTER };
  syncFilterUI();
  recomputeMatches();
  haptic('light');
  if (turnOn && filter.matches.length) fitMatches();
}

/** Opens on New before the first frame, with no toast and no move; an empty
 *  New is allowed, since a read on its way can fill it. */
export function openNew(): void {
  filter.f = { ...NEW_VIEW };
  syncFilterUI();
}

/** What the step bar shows for an empty view. An empty New from a link waits for
 *  this session's reads before it shows that for sure. */
function emptyLabel(): string {
  if (!onlyNew()) return 'None';
  return flags.chainField && F.held.size === 0 ? 'Nothing new' : 'Nothing new yet';
}

export function resetFilter(): void {
  filter.f = { show: 'all', rare: false, isNew: false, d0: 0, d1: 1e9 };
  syncFilterUI();
  if (filtOpen()) buildHist();
  recomputeMatches();
  haptic('tick');
}

export function syncFilterUI(): void {
  const f = filter.f;
  els.fShow.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.v === f.show));
  });
  els.fOnly.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.k === 'rare' ? f.rare : false));
  });
  els.filtSheet.classList.toggle('is-miss', f.show === 'missing');
  els.hMiss.hidden = f.show !== 'missing';
  syncPresets();
}

const HG = {
  bins: [] as number[],
  bin: 1,
  w: 300,
  h: 96,
  dp: 1,
  drag: null as {
    mode: 'L' | 'R' | 'band' | 'new';
    x0: number;
    b0: number;
    b1: number;
    start: number;
    moved: boolean;
  } | null,
  play: null as Task | null,
  raf: 0,
};
const binOf = (d: number): number => Math.floor(d / HG.bin);
const dateAt = (d: number): Date => dateOfDay((F.span.first ?? 0) + d);

export function buildHist(): void {
  const none = !hasHistory(F.span);
  els.hist.hidden = none;
  els.wbot.hidden = none;
  els.hNone.hidden = !none;
  // With nothing found, the note alone shows what the chart will be.
  const cap = els.filtSheet.querySelector<HTMLElement>('.grid-hcap');
  if (cap) cap.hidden = none;
  if (none) {
    HG.bins = [];
    els.hSum.textContent = 'Your finds by day';
    return;
  }
  const span = last() + 1;
  HG.bin = span <= 90 ? 1 : span <= 730 ? 7 : 30;
  HG.bins = new Array<number>(Math.ceil(span / HG.bin)).fill(0);
  for (let i = 0; i < F.pieces.length; i++) {
    if (!isOwned(i) || (filter.f.rare && !isRare(i))) continue;
    const d = foundDay(F.pieces[i]!, F.span);
    if (d !== undefined && d >= 0 && d <= last()) HG.bins[binOf(d)]! += 1;
  }
  HG.w = Math.max(200, els.hist.getBoundingClientRect().width);
  HG.dp = Math.min(window.devicePixelRatio || 1, 2);
  els.histCv.width = HG.w * HG.dp;
  els.histCv.height = HG.h * HG.dp;
  els.histCv.style.height = `${HG.h}px`;
  els.hFrom.max = String(last());
  els.hTo.max = String(last());
  renderHist();
}

const curBins = (): [number, number] => [binOf(Math.max(0, filter.f.d0)), binOf(Math.min(last(), filter.f.d1))];

function renderHist(): void {
  if (!HG.bins.length) return;
  const c = els.histCv.getContext('2d')!;
  const tokStyle = getComputedStyle(els.app);
  const nested = tokStyle.getPropertyValue('--nested').trim();
  const fg = tokStyle.getPropertyValue('--fg').trim();
  const fg2 = tokStyle.getPropertyValue('--fg2').trim();
  const fg3 = tokStyle.getPropertyValue('--fg3').trim();
  const surface = tokStyle.getPropertyValue('--surface').trim();
  const w = HG.w;
  const nb = HG.bins.length;
  const bw = w / nb;
  const top = 4;
  const base = 56;
  const ty = 70;
  const max = Math.max(1, ...HG.bins);
  const [b0, b1] = curBins();
  const isFull = full();
  c.setTransform(HG.dp, 0, 0, HG.dp, 0, 0);
  c.clearRect(0, 0, w, HG.h);
  const gap = bw > 5 ? Math.min(3, bw * 0.25) : 0.6;
  if (!isFull) {
    c.fillStyle = nested;
    roundRect(c, b0 * bw, 0, (b1 - b0 + 1) * bw, base + 2, 8);
    c.fill();
  }
  for (let b = 0; b < nb; b++) {
    const n = HG.bins[b]!;
    const sel = isFull || (b >= b0 && b <= b1);
    const bwid = Math.min(28, Math.max(1, bw - gap));
    const x = b * bw + (bw - bwid) / 2;
    const h = n ? Math.max(4, ((base - top - 4) * n) / max) : 2;
    c.globalAlpha = sel ? 1 : 0.35;
    c.fillStyle = sel && !isFull ? fg : fg2;
    roundRect(c, x, base - h, bwid, h, Math.min(3, bwid / 2));
    c.fill();
  }
  c.globalAlpha = 1;
  c.fillStyle = nested;
  roundRect(c, 0, ty - 2, w, 4, 2);
  c.fill();
  const xa = b0 * bw;
  const xb = (b1 + 1) * bw;
  c.fillStyle = holo(c, (xa + xb) / 2, ty, Math.max(20, (xb - xa) / 2), 0);
  c.fillRect(xa, ty - 2, xb - xa, 4);
  // A handle whose slider has keyboard focus wears the focus ring, since the
  // slider itself is drawn here, not shown.
  const focused = document.activeElement;
  [xa, xb].forEach((x, k) => {
    const hx = clamp(x, 11, w - 11);
    c.fillStyle = surface;
    c.strokeStyle = fg3;
    c.lineWidth = 1;
    c.beginPath();
    c.arc(hx, ty, 11, 0, 6.2832);
    c.fill();
    c.stroke();
    if (focused === (k ? els.hTo : els.hFrom) && focused.matches(':focus-visible')) {
      c.strokeStyle = '#4d8dff';
      c.lineWidth = 2;
      c.beginPath();
      c.arc(hx, ty, 14, 0, 6.2832);
      c.stroke();
    }
    c.fillStyle = fg2;
    c.fillRect(hx - 0.75, ty - 4, 1.5, 8);
  });
  c.font = `500 11px ${UI_FONT}`;
  c.fillStyle = fg2;
  c.textBaseline = 'alphabetic';
  let lastX = -99;
  let lastM = -1;
  for (let b = 0; b < nb; b++) {
    const d = dateAt(b * HG.bin);
    const x = b * bw + (nb <= 14 ? bw / 2 : 0);
    let t: string | null = null;
    if (nb <= 14) t = String(d.getDate());
    else if (d.getMonth() !== lastM) {
      t = monthName(d);
      lastM = d.getMonth();
    }
    if (t && x - lastX >= (nb <= 14 ? 14 : 28)) {
      c.textAlign = nb <= 14 ? 'center' : 'left';
      c.fillText(t, Math.max(0, x), 93);
      lastX = x;
    }
  }
  c.textAlign = 'left';
  els.hSum.textContent = isFull ? 'All time' : rangeLabel(filter.f, F.span);
  els.hFrom.value = String(Math.max(0, filter.f.d0));
  els.hTo.value = String(Math.min(last(), filter.f.d1));
  syncPresets();
}

/** A preset longer than the history would just mean All, so it is off. */
function syncPresets(): void {
  const l = last();
  const a = Math.max(0, filter.f.d0);
  const b = Math.min(l, filter.f.d1);
  els.fPreset.querySelectorAll<HTMLButtonElement>('button').forEach((x) => {
    const p = Number(x.dataset.p);
    x.disabled = p > 0 && l + 1 <= p;
    x.setAttribute('aria-pressed', String(p === 0 ? full() : !x.disabled && b === l && a === Math.max(0, l - p + 1)));
  });
}

function setRange(d0: number, d1: number): void {
  const l = last();
  const n0 = clamp(Math.min(d0, d1), 0, l);
  const n1 = clamp(Math.max(d0, d1), 0, l);
  if (n0 === Math.max(0, filter.f.d0) && n1 === Math.min(l, filter.f.d1)) return;
  const f = filter.f;
  filter.f = {
    ...f,
    d0: n0,
    d1: n1 >= l && n0 <= 0 ? 1e9 : n1,
    show: f.show === 'missing' ? 'all' : f.show,
    isNew: false,
  };
  haptic('tick');
  renderHist();
  syncFilterUI();
  if (!HG.raf)
    HG.raf = requestAnimationFrame(() => {
      HG.raf = 0;
      recomputeMatches();
    });
}

function setBins(b0: number, b1: number): void {
  const nb = HG.bins.length;
  b0 = clamp(b0, 0, nb - 1);
  b1 = clamp(b1, 0, nb - 1);
  setRange(Math.min(b0, b1) * HG.bin, Math.min(last(), (Math.max(b0, b1) + 1) * HG.bin - 1));
}

const histX = (e: PointerEvent): number => e.clientX - els.histCv.getBoundingClientRect().left;

export function attachFilters(): void {
  // A fresh screen starts unfiltered: its chips and chart are new, and no replay runs.
  HG.play = null;
  HG.drag = null;
  filter.f = { ...NO_FILTER };
  filter.matches = [];
  filter.matchSet = new Set();
  filter.stepIdx = -1;
  const act = (name: string, fn: () => void): void => {
    const b = els.app.querySelector<HTMLElement>(`[data-act="${name}"]`);
    if (b) on(b, 'click', fn);
  };
  act('hist-play', playHistory);
  act('filter-clear', () => resetFilter());
  act('step-prev', () => stepTo(-1));
  act('step-next', () => stepTo(1));
  act('step-clear', () => resetFilter());
  on(els.fFit, 'click', showMatches);
  on(els.fShow, 'click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (!b) return;
    const v = b.dataset.v as 'found' | 'missing';
    const f = filter.f;
    const show = f.show === v ? 'all' : v;
    filter.f = { ...f, show, ...(show === 'missing' ? { d0: 0, d1: 1e9 } : {}) };
    syncFilterUI();
    if (filtOpen()) renderHist();
    recomputeMatches();
    haptic('tick');
  });
  on(els.fOnly, 'click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (!b) return;
    filter.f = { ...filter.f, rare: !filter.f.rare };
    syncFilterUI();
    recomputeMatches();
    if (filtOpen()) buildHist();
    haptic('tick');
  });
  on(els.fPreset, 'click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (!b) return;
    const p = Number(b.dataset.p);
    if (p === 0) setRange(0, 1e9);
    else setRange(Math.max(0, last() - p + 1), last());
  });
  on(els.hFrom, 'input', () => setRange(Number(els.hFrom.value), Math.min(last(), filter.f.d1)));
  on(els.hTo, 'input', () => setRange(Math.max(0, filter.f.d0), Number(els.hTo.value)));
  for (const r of [els.hFrom, els.hTo]) {
    on(r, 'focus', renderHist);
    on(r, 'blur', renderHist);
  }
  on(els.hist, 'pointerdown', (e) => {
    if (HG.play || !HG.bins.length) return;
    const x = histX(e);
    const nb = HG.bins.length;
    const bw = HG.w / nb;
    const [b0, b1] = curBins();
    const xa = b0 * bw;
    const xb = (b1 + 1) * bw;
    const isFull = full();
    const bAt = clamp(Math.floor(x / bw), 0, nb - 1);
    let mode: 'L' | 'R' | 'band' | 'new' = 'new';
    const dA = Math.abs(x - xa);
    const dB = Math.abs(x - xb);
    if (Math.min(dA, dB) < 22 && (!isFull || e.clientY - els.histCv.getBoundingClientRect().top > 58))
      mode = dA < dB ? 'L' : 'R';
    else if (!isFull && x > xa && x < xb) mode = 'band';
    HG.drag = { mode, x0: x, b0, b1, start: bAt, moved: false };
    try {
      els.hist.setPointerCapture(e.pointerId);
    } catch {
      // released already
    }
  });
  on(els.hist, 'pointermove', (e) => {
    const g = HG.drag;
    if (!g) return;
    const x = histX(e);
    const nb = HG.bins.length;
    const bw = HG.w / nb;
    const b = clamp(Math.floor(x / bw), 0, nb - 1);
    if (Math.abs(x - g.x0) > 4) g.moved = true;
    if (!g.moved) return;
    if (g.mode === 'L') setBins(Math.min(b, g.b1), g.b1);
    else if (g.mode === 'R') setBins(g.b0, Math.max(b, g.b0));
    else if (g.mode === 'band') {
      const d = Math.round((x - g.x0) / bw);
      const span = g.b1 - g.b0;
      const n0 = clamp(g.b0 + d, 0, nb - 1 - span);
      setBins(n0, n0 + span);
    } else setBins(g.start, b);
  });
  on(els.hist, 'pointerup', () => {
    const g = HG.drag;
    HG.drag = null;
    if (!g || g.moved || g.mode === 'L' || g.mode === 'R') return;
    const [b0, b1] = curBins();
    if (!full() && b0 === b1 && b0 === g.start) setRange(0, 1e9);
    else setBins(g.start, g.start);
  });
  on(els.hist, 'pointercancel', () => {
    HG.drag = null;
  });
}

/** Replay the collection over time: the range sweeps from the first find to today. */
function playHistory(): void {
  if (HG.play) return;
  const l = last();
  const t0 = performance.now();
  const dur = motion.reduced ? 1 : clamp(1400 + l * 10, 1600, 4200);
  filter.f = { ...filter.f, show: 'all', rare: false, isNew: false };
  syncFilterUI();
  const task: Task = (now) => {
    const p = clamp((now - t0) / dur, 0, 1);
    const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
    filter.f = { ...filter.f, d0: 0, d1: p >= 1 ? 1e9 : Math.round(e * l) };
    renderHist();
    recomputeMatches();
    if (p >= 1) {
      HG.play = null;
      return false;
    }
    return true;
  };
  HG.play = task;
  tasks.add(task);
  kick();
  haptic('light');
}

function showMatches(): void {
  closeSheets();
  if (fActive()) fitMatches();
}

function fitMatches(): void {
  if (!filter.matches.length) return;
  let y0 = 1e9;
  let y1 = -1e9;
  const { py } = F.layout;
  for (const i of filter.matches) {
    y0 = Math.min(y0, py[i]!);
    y1 = Math.max(y1, py[i]!);
  }
  fitRows(y0 - 1, y1 + 1);
}

function nearestMatch(): number {
  let best = 0;
  let bd = 1e9;
  const { px, py } = F.layout;
  const x = wx(view.W / 2);
  filter.matches.forEach((i, k) => {
    const d = Math.hypot(px[i]! - x, py[i]! - cam.y);
    if (d < bd) {
      bd = d;
      best = k;
    }
  });
  return best;
}

/** Step to the next or previous match, starting from the one nearest the
 *  middle of the view. */
function stepTo(d: 1 | -1): void {
  const m = filter.matches;
  if (!m.length) return;
  filter.stepIdx = filter.stepIdx < 0 ? nearestMatch() : (filter.stepIdx + d + m.length) % m.length;
  const i = m[filter.stepIdx]!;
  els.stepPos.textContent = `${filter.stepIdx + 1} of ${m.length}`;
  scrollTo(framePiece(i), 0, (cut) => {
    if (cut) return;
    F.focusI = i;
    F.focusT = performance.now();
    kick();
  });
  showFocusName(i);
  haptic('tick');
}

let focusReadT = 0;
/** While stepping, the header names the piece you landed on for a moment. A
 *  missing piece is named only by its number. */
export function showFocusName(i: number): void {
  if (lensState.on) return;
  const a = areaOfI(i);
  const cell = F.layout.cells[i];
  if (!a || !cell) return;
  const when = foundAt(i);
  if (isShown(i))
    setReadout(nameOf(i), [when ? `Found ${shortDate(when)}` : '', placeOf(i)].filter(Boolean).join(' · '), {
      rare: isRare(i),
    });
  else
    setReadout('Not found yet', `${placeOf(i)}${cell.no ? ` · No. ${cell.no}` : ''}`, {
      muted: true,
      rare: isRare(i),
    });
  els.head.classList.add('is-reading');
  window.clearTimeout(focusReadT);
  focusReadT = window.setTimeout(() => {
    if (!lensState.on) els.head.classList.remove('is-reading');
  }, 2600);
}
