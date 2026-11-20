// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// Search: names only for pieces you found, plus collections and tiers. Closing
// a piece opened from here flies it back to its row with the query in place. A
// piece still flying in on an arrival is not listed until it lands.

import { shortDate } from '../model/days';
import { searchField } from '../model/search';
import { camMoved, fitRows, framePiece, stopCam } from './camera';
import { cam, els, F, foundAt, nameOf, on, placeOf } from './core';
import { DT, openDetail, rectOf } from './detail';
import { focusBack, focusInto } from './focus';
import { haptic } from './haptic';
import { hideHint } from './hint';
import { syncHistory } from './history';
import { closeLoupe } from './lens';
import { closeSheets } from './sheets';
import { drawThumb } from './thumbs';

export const searchOpen = (): boolean => els.search.classList.contains('is-open');

let sLast = '';
let sAll = false;
let sLastAll = false;

function openSearch(q = '', instant = false, all = false): void {
  closeSheets();
  closeLoupe('now');
  hideHint();
  if (instant) {
    els.search.classList.add('is-instant');
    requestAnimationFrame(() => requestAnimationFrame(() => els.search.classList.remove('is-instant')));
  }
  els.search.classList.add('is-open');
  syncHistory();
  els.sInput.value = q;
  sAll = all;
  renderResults(els.sInput.value);
  if (!instant) window.setTimeout(() => focusInto(els.search, els.sInput), 60);
}

/** Close search; `keep` keeps the query so a piece opened from it can
 *  come back to it. */
export function closeSearch(keep = false): void {
  if (!searchOpen()) return;
  sLast = keep ? els.sInput.value : '';
  sLastAll = keep && sAll;
  els.search.classList.remove('is-open');
  syncHistory();
  els.sInput.blur();
  // Closed to open a piece, focus goes with the piece; closed for good, back
  // to the button that opened it.
  if (!keep) focusBack(els.search);
}

/** Reopen search as it was, instantly, for a piece coming back to its row. */
export function reopenSearch(): void {
  openSearch(sLast, true, sLastAll);
}

/** "common and rare", "common, rare and legendary": a collection's tiers in
 *  words, for its row. */
function tierList(names: readonly string[]): string {
  const w = names.map((n) => n.toLowerCase());
  return w.length < 2 ? (w[0] ?? '') : `${w.slice(0, -1).join(', ')} and ${w[w.length - 1]!}`;
}

const GRID_ICON =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><rect x="4" y="4" width="7" height="7" rx="2"/><rect x="13" y="4" width="7" height="7" rx="2"/><rect x="4" y="13" width="7" height="7" rx="2"/><rect x="13" y="13" width="7" height="7" rx="2"/></svg>';

function row(cls: string, title: string, meta: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `grid-s-row${cls ? ` ${cls}` : ''}`;
  const tx = document.createElement('div');
  const n = document.createElement('b');
  const m = document.createElement('small');
  n.textContent = title;
  m.textContent = meta;
  tx.append(n, m);
  b.appendChild(tx);
  return b;
}

function note(text: string): void {
  const d = document.createElement('div');
  d.className = 'grid-s-empty';
  d.textContent = text;
  els.sRes.appendChild(d);
}

function head(text: string): void {
  const h = document.createElement('div');
  h.className = 'grid-s-head';
  h.textContent = text;
  els.sRes.appendChild(h);
}

export function renderResults(qs: string): void {
  const q = qs.trim();
  els.sRes.textContent = '';
  const L = F.layout;
  const found = searchField(q, L, F.pieces);
  const hits = { ...found, pieces: found.pieces.filter((i) => !F.held.has(L.cells[i]!.key)) };
  if (!q) {
    if (hits.pieces.length) head('Recent finds');
    else {
      note('Pieces you find will show up here.');
      return;
    }
  }
  for (const p of hits.places.slice(0, 4)) {
    const r = L.regions[p.region]!;
    const a = p.area !== undefined ? L.areas[p.area] : undefined;
    const own = a ? (F.areaOwn[a.idx] ?? 0) : (F.regionOwn[r.idx] ?? 0);
    const tot = a ? a.n : (F.regionTot[r.idx] ?? 0);
    const meta = a
      ? r.partial
        ? `${r.name} · ${own} found`
        : `${r.name} · ${own} of ${tot} found`
      : r.partial
        ? `${own} found`
        : `${own} of ${tot} found${r.areas.length > 1 ? ` · ${tierList(r.areas.map((x) => L.areas[x]!.name))}` : ''}`;
    const b = row('is-place', a ? a.name : r.name, meta);
    const ic = document.createElement('span');
    ic.className = 'grid-s-ic';
    ic.innerHTML = GRID_ICON;
    b.prepend(ic);
    b.addEventListener('click', () => {
      closeSearch();
      if (a) fitRows(a.y, a.y + a.h);
      else fitRows(r.y, r.y + r.h);
      haptic('tick');
    });
    els.sRes.appendChild(b);
  }
  const cap = sAll ? hits.pieces.length : 8;
  for (const i of hits.pieces.slice(0, cap)) {
    const when = foundAt(i);
    const status = when ? `Found ${shortDate(when)}` : '';
    const b = row('', nameOf(i), [status, placeOf(i)].filter(Boolean).join(' · '));
    b.dataset.i = String(i);
    const th = document.createElement('canvas');
    th.className = 'grid-s-thumb';
    drawThumb(th, i, 40);
    b.prepend(th);
    b.addEventListener('click', () => pickResult(i, th));
    els.sRes.appendChild(b);
  }
  if (hits.pieces.length > cap) {
    const m = document.createElement('button');
    m.type = 'button';
    m.className = 'grid-s-more';
    m.textContent = `Show all ${hits.pieces.length}`;
    m.addEventListener('click', () => {
      sAll = true;
      renderResults(els.sInput.value);
    });
    els.sRes.appendChild(m);
  }
  if (q && !hits.pieces.length && !hits.places.length) note(`Nothing you’ve found matches “${q}”`);
}

/** The search row's thumb for cell i, while search is open. */
export function searchThumb(i: number): HTMLElement | null {
  return els.sRes.querySelector<HTMLElement>(`.grid-s-row[data-i="${i}"] .grid-s-thumb`);
}

function pickResult(i: number, thumb: HTMLElement): void {
  // A piece is open or still moving: the tap does nothing.
  if (DT.open || DT.busy) return;
  const r = rectOf(thumb);
  els.app.classList.add('is-detailing', 'is-instant');
  stopCam();
  cam.y = framePiece(i);
  camMoved();
  requestAnimationFrame(() => els.app.classList.remove('is-instant'));
  thumb.style.visibility = 'hidden';
  closeSearch(true);
  haptic('medium');
  openDetail(i, { x: r.x + r.w / 2, y: r.y + r.h / 2, s: r.w }, false, 'search');
  window.setTimeout(() => {
    thumb.style.visibility = '';
  }, 500);
}

export function attachSearch(): void {
  sLast = '';
  sAll = false;
  sLastAll = false;
  const open = els.app.querySelector<HTMLElement>('[data-act="search"]');
  if (open) on(open, 'click', () => openSearch(''));
  const cancel = els.search.querySelector<HTMLElement>('[data-act="cancel"]');
  if (cancel) on(cancel, 'click', () => closeSearch());
  const scrim = els.search.querySelector<HTMLElement>('.grid-s-scrim');
  if (scrim) on(scrim, 'click', () => closeSearch());
  on(els.sInput, 'input', () => {
    sAll = false;
    renderResults(els.sInput.value);
  });
  on(els.sInput, 'keydown', (e) => {
    if (e.key === 'Enter') els.sRes.querySelector<HTMLElement>('.grid-s-row')?.click();
  });
}
