// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// The bottom sheets: Collections (every collection with its progress, and its
// tiers) and Filter. One open at a time, over a scrim.

import { fitAll, fitRows } from './camera';
import { cam, els, F, isShown, on, view, wx } from './core';
import { buildHist, syncFilterUI, toggleNew } from './filters';
import { focusBack, focusInto } from './focus';
import { haptic } from './haptic';
import { syncHistory } from './history';
import { areaAt } from './lens';
import { closeLoupe } from './lens';
import { drawThumb } from './thumbs';

export const sheetOpen = (): boolean => Boolean(document.querySelector('.grid-psheet.is-open'));
export const filtOpen = (): boolean => els.filtSheet.classList.contains('is-open');

function openSheet(el: HTMLElement): void {
  closeSheets(true);
  closeLoupe('now');
  el.classList.add('is-open');
  syncHistory();
  els.scrim.classList.add('is-on');
  els.scrim.classList.toggle('is-clear', el === els.filtSheet);
  focusInto(el, el.querySelector<HTMLElement>('[data-close]'));
}

export function closeSheets(keepScrim = false): void {
  document.querySelectorAll<HTMLElement>('.grid-psheet.is-open').forEach((el) => {
    el.classList.remove('is-open');
    focusBack(el);
  });
  syncHistory();
  if (!keepScrim) els.scrim.classList.remove('is-on');
}

let cSort: 'recent' | 'az' | 'progress' = 'recent';
let cQuery = '';
const cOpen = new Set<string>();

/** A fresh screen starts the sheet fresh: its field and sort buttons are new. */
export function resetSheets(): void {
  cSort = 'recent';
  cQuery = '';
  cOpen.clear();
}

/** Where a collection without its full set stands, in words. */
function partialNote(why: string | undefined): string {
  if (why === 'loading') return 'loading the rest';
  if (why === 'failed') return 'the rest didn’t load, trying again';
  return 'showing yours';
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const CHEVRON =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';

export function buildCollList(): void {
  const list = els.collSheet.querySelector<HTMLElement>('.grid-coll-list');
  if (!list) return;
  list.textContent = '';
  const q = cQuery.trim().toLowerCase();
  const L = F.layout;
  const here = L.areas[areaAt(wx(view.W / 2), cam.y)];
  const total = L.cells.length;
  if (!q && L.regions.length > 1) {
    const row = el('div', 'grid-crow2');
    const b = el('button', 'grid-cmain');
    b.type = 'button';
    const text = el('span', 'grid-ctext');
    const known = !L.regions.some((r) => r.partial);
    text.append(
      el('b', undefined, 'All collections'),
      el('small', undefined, known ? `${F.foundCount}/${total}` : `${F.foundCount} found`),
    );
    b.append(el('span', 'grid-cthumbs'), text);
    b.addEventListener('click', () => {
      closeSheets();
      fitAll();
    });
    row.appendChild(b);
    list.appendChild(row);
  }
  const regs = L.regions.slice();
  const own = (r: number): number => F.regionOwn[r] ?? 0;
  const tot = (r: number): number => Math.max(1, F.regionTot[r] ?? 1);
  if (cSort === 'az') regs.sort((a, b) => a.name.localeCompare(b.name));
  else if (cSort === 'progress') regs.sort((a, b) => own(b.idx) / tot(b.idx) - own(a.idx) / tot(a.idx));
  else regs.sort((a, b) => (F.regionRecent[b.idx] ?? -1) - (F.regionRecent[a.idx] ?? -1));
  let shown = 0;
  for (const r of regs) {
    const multi = r.areas.length > 1;
    const hitName = !q || r.name.toLowerCase().includes(q);
    const hitSub = multi && q ? r.areas.filter((a) => L.areas[a]!.name.toLowerCase().includes(q)) : [];
    if (!hitName && !hitSub.length) continue;
    shown++;
    const row = el('div', 'grid-crow2');
    const owned: number[] = [];
    for (const a of r.areas) for (let i = L.areas[a]!.from; i < L.areas[a]!.to; i++) if (isShown(i)) owned.push(i);
    owned.sort((a, b) => (F.pieces[b]?.foundAt ?? 0) - (F.pieces[a]?.foundAt ?? 0));
    const thumbs = el('span', 'grid-cthumbs');
    for (const i of owned.slice(0, 3)) {
      const t = el('canvas', 'grid-cthumb');
      drawThumb(t, i, 30);
      thumbs.appendChild(t);
    }
    const b = el('button', 'grid-cmain');
    b.type = 'button';
    const text = el('span', 'grid-ctext');
    text.append(
      el('b', undefined, r.name),
      el(
        'small',
        undefined,
        r.partial
          ? `${own(r.idx)} found \u00b7 ${partialNote(r.partialWhy)}`
          : `${own(r.idx)}/${F.regionTot[r.idx] ?? 0}`,
      ),
    );
    const meter = el('span', 'grid-cmeter');
    const fill = el('i');
    fill.style.width = `${r.partial ? 0 : ((own(r.idx) / tot(r.idx)) * 100).toFixed(1)}%`;
    meter.appendChild(fill);
    b.append(thumbs, text, meter);
    b.addEventListener('click', () => {
      closeSheets();
      fitRows(r.y, r.y + r.h);
    });
    row.appendChild(b);
    const open = multi && (cOpen.has(r.id) || hitSub.length > 0);
    if (multi) {
      const x = el('button', 'grid-cexp');
      x.type = 'button';
      x.innerHTML = CHEVRON;
      x.setAttribute('aria-label', `Show ${r.name} by rarity`);
      x.setAttribute('aria-expanded', String(open));
      x.addEventListener('click', () => {
        if (cOpen.has(r.id)) cOpen.delete(r.id);
        else cOpen.add(r.id);
        buildCollList();
      });
      row.appendChild(x);
    }
    list.appendChild(row);
    if (open) {
      const g = el('div', 'grid-srows');
      for (const ai of hitSub.length ? hitSub : r.areas) {
        const a = L.areas[ai]!;
        const sb = el('button', `grid-srow${a === here ? ' is-here' : ''}`, a.name);
        sb.type = 'button';
        sb.appendChild(el('small', undefined, `${F.areaOwn[a.idx] ?? 0}/${a.n}`));
        sb.addEventListener('click', () => {
          closeSheets();
          fitRows(a.y, a.y + a.h);
        });
        g.appendChild(sb);
      }
      list.appendChild(g);
    }
  }
  if (!shown && q) list.appendChild(el('div', 'grid-cempty', `No collection called “${cQuery.trim()}”`));
}

export function attachSheets(): void {
  on(els.scrim, 'click', () => closeSheets());
  els.app.querySelectorAll<HTMLElement>('[data-close]').forEach((b) => on(b, 'click', () => closeSheets()));
  const bColl = els.dock.querySelector<HTMLElement>('[data-act="coll"]');
  if (bColl)
    on(bColl, 'click', () => {
      buildCollList();
      openSheet(els.collSheet);
      haptic('tick');
    });
  on(els.bNew, 'click', toggleNew);
  on(els.bFilter, 'click', () => {
    syncFilterUI();
    openSheet(els.filtSheet);
    requestAnimationFrame(buildHist);
    haptic('tick');
  });
  const cInput = els.collSheet.querySelector<HTMLInputElement>('input');
  if (cInput)
    on(cInput, 'input', () => {
      cQuery = cInput.value;
      buildCollList();
    });
  const cSortEl = els.collSheet.querySelector<HTMLElement>('.grid-seg');
  if (cSortEl)
    on(cSortEl, 'click', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (!b) return;
      cSort = (b.dataset.s ?? 'recent') as typeof cSort;
      cSortEl.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      buildCollList();
      haptic('tick');
    });
}
