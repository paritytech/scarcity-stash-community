// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// The detail view: the piece flies onto a stage and a sheet rises under it, at
// peek (the name, where it lives, two lines of description) or expanded (the
// full description, the collection's fields, your copy). A credit shows the
// piece it would give. Closing works from any moment; paging is one slide at a
// time.

import { tierLabel } from '@/entities/art/resolver';
import type { TraitRow } from '@/entities/collections/traits';
import { deviceStore } from '@/shared/lib/deviceStore';

import { artCell, artSrc, CELL, whenArt } from '../art';
import { type CopyPage, copyPages, pageOf, startPage } from '../model/copies';
import { dayNumber, longDate } from '../model/days';
import { detailInfo, hasInfo } from '../model/detailInfo';
import { filterLabel } from '../model/filter';
import { pieceSize } from '../model/grid';
import { pageList, tierPlace, wrapIndex } from '../model/paging';
import { pullsSheet, wheelOpens } from '../model/sheet';
import { camMoved, framePiece, stopCam } from './camera';
import {
  areaOfI,
  BOTI,
  cam,
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
  on,
  ownUrl,
  regionOfA,
  sx,
  sy,
  TOPI,
  view,
} from './core';
import { fActive } from './filters';
import { focusBack, focusInto } from './focus';
import { haptic } from './haptic';
import { hideHint } from './hint';
import { syncHistory } from './history';
import { closeLoupe } from './lens';
import { reopenSearch, searchThumb } from './search';
import { markSeen } from './seen';
import { drawThumb } from './thumbs';
import { tilt } from './tilt';
import { flushToast } from './toast';
import { clamp, lerp, Spring } from './util';

interface Spot {
  x: number;
  y: number;
  s: number;
}

export const DT = {
  open: false,
  closing: false,
  phase: '' as '' | 'opening' | 'open' | 'closing',
  expanded: false,
  i: -1,
  list: [] as number[],
  idx: 0,
  ctx: '',
  ctxArea: true,
  rot: new Spring(0, 120, 18),
  drag: null as {
    id: number;
    x0: number;
    y0: number;
    lock: 'h' | 'v' | null;
    r0: number;
    lx: number;
    lt: number;
    vx: number;
  } | null,
  busy: false,
  queue: 0,
  anim: null as Animation | null,
  from: '' as '' | 'search',
  geo: { off: 190, k: 0.5, peekH: 330, stageH: 420 },
  /** How far peek rises above the sheet's share of the screen, and the
   *  stage's scale in peek, both from fitPeek. */
  rise: 0,
  pk: 1,
  info: false,
  land: false,
  /** The open piece's hash and picture, kept so its close finds and flies to
   *  the right piece even after the piece has left the field. */
  hash: '',
  src: '',
  /** The page of the open square that shows, its own or a credit's standing on
   *  it (model/copies.ts), and that credit's hash, which the page follows. */
  copy: 0,
  copyHash: '',
};

export const detailOpen = (): boolean => DT.open;

/** Records the open piece by its hash, so a redraw can find it again. */
function recordOpenPiece(i: number): void {
  DT.hash = F.pieces[i]?.look?.entry.hashHex ?? '';
}
function clearOpenPiece(): void {
  DT.hash = '';
}

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the caller names the element type the markup guarantees
const q = <T extends Element>(sel: string): T => els.detail.querySelector<T>(sel)!;

export function applyPieceTilt(): void {
  if (!DT.open) return;
  const r = DT.rot.x + tilt.x.x * 10;
  const rx = -tilt.y.x * 6;
  els.pieceTilt.style.transform = `perspective(900px) rotateY(${r.toFixed(2)}deg) rotateX(${rx.toFixed(2)}deg)`;
  els.sheen.style.backgroundPosition = `${(50 - r * 1.4).toFixed(1)}% 0`;
}

/** Paging covers the filter's matches when a filter is on, otherwise every
 *  piece you have, in the grid's order (model/paging.ts). */
function listFor(i: number): { list: number[]; ctx: string; area: boolean } {
  if (fActive() && filter.matchSet.has(i))
    return { list: pageList(F.layout, isShown, filter.matches), ctx: filterLabel(filter.f, F.span), area: false };
  return { list: pageList(F.layout, isShown), ctx: '', area: true };
}

/** A data URL of the atlas cell, for the moment before the full picture is in. */
function cropUrl(url: string | undefined): string | undefined {
  const art = artCell(url);
  if (!art) return undefined;
  const c = document.createElement('canvas');
  c.width = c.height = CELL;
  c.getContext('2d')!.drawImage(art.page, art.sx, art.sy, CELL, CELL, 0, 0, CELL, CELL);
  return c.toDataURL();
}

const pieceUrl = (i: number): string => artSrc(ownUrl(i)) ?? cropUrl(ownUrl(i)) ?? '';

/** Show `u` on the stage, or, with no picture yet, a soft placeholder rather
 *  than a broken image. */
function putPicture(u: string): void {
  DT.src = u;
  els.stage.classList.toggle('is-noart', !u);
  if (!u) {
    els.pieceImg.removeAttribute('src');
    els.sheen.style.removeProperty('-webkit-mask-image');
    els.sheen.style.removeProperty('mask-image');
    return;
  }
  els.pieceImg.src = u;
  els.sheen.style.setProperty('-webkit-mask-image', `url("${u}")`);
  els.sheen.style.maskImage = `url("${u}")`;
}

function setText(sel: string, text: string): HTMLElement {
  const e = q<HTMLElement>(sel);
  e.textContent = text;
  return e;
}

/** Square i's pages: its own, then each credit standing on it. */
const pagesOf = (i: number): CopyPage[] => {
  const p = F.pieces[i];
  return p ? copyPages(p) : [];
};

/** Square i opens on its first page, or with New showing on the first page
 *  with something new on it. */
function startCopy(i: number): void {
  const p = F.pieces[i];
  const pages = pagesOf(i);
  DT.copy = p ? startPage(p, pages, Math.floor(Date.now() / 1000), filter.f.isNew) : 0;
  const page = pages[DT.copy];
  DT.copyHash = page?.kind === 'credit' ? page.entry.hashHex : '';
}

function fillDetail(i: number): void {
  const a = areaOfI(i);
  const region = a ? regionOfA(a) : undefined;
  const cell = F.layout.cells[i]!;
  const p = F.pieces[i]!;
  const look = p.look;
  // The page that shows: where its credit stands now, kept within the pages.
  const pages = copyPages(p);
  const at = DT.copyHash ? pageOf(pages, DT.copyHash) : -1;
  DT.copy = clamp(at >= 0 ? at : DT.copy, 0, Math.max(0, pages.length - 1));
  const page = pages[DT.copy];
  const credit = page?.kind === 'credit' ? page.entry : null;
  DT.copyHash = credit ? credit.hashHex : '';
  const url = ownUrl(i);
  putPicture(pieceUrl(i));
  if (!artSrc(url) && url)
    void whenArt(url, 90).then((u) => {
      if (u && DT.i === i && DT.open) putPicture(u);
    });
  setText('.grid-d-name', nameOf(i));
  // The chip names a rare piece's tier, so the path names it only otherwise.
  const where =
    region && region.areas.length > 1 && a && !isRare(i) ? `${region.name} · ${a.name}` : (region?.name ?? '');
  setText('.grid-d-path', `${where}${cell.no ? ` · No. ${cell.no} of ${cell.of ?? cell.no}` : ''}`);
  const chip = q<HTMLElement>('.grid-rchip');
  chip.hidden = !isRare(i);
  chip.textContent = look ? tierLabel(look.entry.resolved) : 'Rare';
  els.detail.classList.toggle('is-nochip', chip.hidden);
  const when = foundAt(i);
  const own = [when ? `Found ${longDate(when)}` : '', p.copies > 1 ? `You have ${p.copies}` : '']
    .filter(Boolean)
    .join(' · ');
  setText('.grid-d-own', own);
  setText('.grid-d-copy', own);
  // The copies on this square, paged beside the name.
  const many = pages.length > 1;
  q<HTMLElement>('.grid-d-step').hidden = !many;
  els.detail.classList.toggle('has-step', many);
  setText('.grid-d-stepn', many ? `${String(DT.copy + 1)} of ${String(pages.length)}` : '');
  q<HTMLButtonElement>('[data-act="copy-prev"]').disabled = DT.copy === 0;
  q<HTMLButtonElement>('[data-act="copy-next"]').disabled = DT.copy >= pages.length - 1;
  const info = detailInfo(look?.entry.resolved.metadata, region?.sharedDescription);
  const has = hasInfo(info);
  DT.info = has;
  els.detail.classList.toggle('is-info', has);
  if (!has) setExpanded(false);
  const desc = setText('.grid-d-desc', info.desc ?? '');
  desc.hidden = !info.desc;
  q<HTMLElement>('.grid-d-more').hidden = !has;
  const about = q<HTMLElement>('.grid-about');
  about.textContent = '';
  if (look) about.style.setProperty('--glow', look.entry.resolved.glow);
  for (const t of info.traits) about.appendChild(traitRow(t));
  about.hidden = !info.traits.length;
  q<HTMLElement>('.grid-d-about-h').hidden = !info.traits.length;
  // The pieces found the same day, a way to wander through one game's finds.
  const w = q<HTMLElement>('.grid-with');
  w.textContent = '';
  const day = p.foundAt !== undefined ? dayNumber(p.foundAt) : null;
  if (day !== null) {
    const mates: number[] = [];
    for (let k = 0; k < F.pieces.length && mates.length < 5; k++) {
      const o = F.pieces[k]!;
      if (k !== i && isShown(k) && o.foundAt !== undefined && dayNumber(o.foundAt) === day) mates.push(k);
    }
    if (mates.length) {
      const th = document.createElement('div');
      th.className = 'grid-with-thumbs';
      for (const m of mates) {
        const b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('aria-label', nameOf(m));
        const t = document.createElement('canvas');
        drawThumb(t, m, 34);
        b.appendChild(t);
        b.addEventListener('click', () => jumpTo(m));
        th.appendChild(b);
      }
      const sp = document.createElement('span');
      sp.textContent = 'Also found that day';
      w.append(th, sp);
    }
  }
  (has ? q<HTMLElement>('.grid-d-copybox') : q<HTMLElement>('.grid-d-head')).appendChild(w);
  els.detail.classList.toggle('is-rare', isRare(i));
  els.detail.classList.toggle('is-single', DT.list.length < 2);
  // The piece's place in its tier, "2 of 6 Rare in Sports", or in the
  // filter's matches, "2 of 8 · Rare".
  setText(
    '.grid-pager',
    DT.ctxArea
      ? tierPlace(F.layout, isShown, i)
      : DT.list.length < 2
        ? DT.ctx.charAt(0).toUpperCase() + DT.ctx.slice(1)
        : `${DT.idx + 1} of ${DT.list.length} \u00b7 ${DT.ctx}`,
  );
  fitPeek();
}

/** One trait: its label, its value and unit, and the score as a bar in the
 *  piece's glow. A screen reader hears the score in words instead of the bar. */
function traitRow(t: TraitRow): HTMLElement {
  const d = document.createElement('div');
  const dt = document.createElement('dt');
  const dd = document.createElement('dd');
  dt.textContent = t.label;
  const v = document.createElement('span');
  v.className = 'grid-trait-v';
  v.textContent = t.value;
  if (t.unit) {
    const u = document.createElement('small');
    u.textContent = ` ${t.unit}`;
    v.appendChild(u);
  }
  dd.appendChild(v);
  if (t.score) {
    const bar = document.createElement('span');
    bar.className = 'grid-trait-bar';
    bar.setAttribute('aria-hidden', 'true');
    const track = document.createElement('span');
    const fill = document.createElement('i');
    fill.style.width = `${(t.score.fill * 100).toFixed(1)}%`;
    track.appendChild(fill);
    const n = document.createElement('b');
    n.textContent = t.score.text;
    bar.append(track, n);
    const sr = document.createElement('span');
    sr.className = 'grid-sr';
    sr.textContent = `, score ${t.score.text} of ${t.score.max}`;
    dd.append(bar, sr);
  }
  d.append(dt, dd);
  return d;
}

/** Empty the closed detail, so no name stays in the page once its piece may
 *  have left the collection. */
function clearDetail(): void {
  for (const sel of [
    '.grid-d-name',
    '.grid-d-path',
    '.grid-d-own',
    '.grid-d-copy',
    '.grid-d-desc',
    '.grid-about',
    '.grid-with',
    '.grid-pager',
  ])
    q<HTMLElement>(sel).textContent = '';
  els.pieceImg.removeAttribute('src');
  DT.src = '';
}

export function setExpanded(on: boolean): void {
  const next = on && DT.info && !DT.land;
  if (DT.expanded === next) return;
  DT.expanded = next;
  els.detail.classList.toggle('is-expanded', next);
  if (!next) {
    els.sheetBody.scrollTop = 0;
    fitPeek();
  }
}

export function rectOf(el: Element): { x: number; y: number; w: number; h: number } {
  const r = el.getBoundingClientRect();
  return { x: r.left - view.left, y: r.top - view.top, w: r.width, h: r.height };
}

function fly(url: string, from: Spot, to: Spot, dur: number, easing: string): Animation {
  const base = Math.max(from.s, to.s);
  const f = els.flyer;
  f.src = url;
  f.style.width = `${base}px`;
  f.style.height = `${base}px`;
  f.style.visibility = 'visible';
  return f.animate(
    [
      { transform: `translate3d(${from.x - base / 2}px,${from.y - base / 2}px,0) scale(${from.s / base})` },
      { transform: `translate3d(${to.x - base / 2}px,${to.y - base / 2}px,0) scale(${to.s / base})` },
    ],
    { duration: motion.reduced ? 1 : dur, easing, fill: 'forwards' },
  );
}

/** Where the flyer is right now, so an interrupted flight carries on from there. */
function flyerNow(): Spot {
  const m = new DOMMatrix(getComputedStyle(els.flyer).transform);
  const b = parseFloat(els.flyer.style.width) || 1;
  return { x: m.m41 + b / 2, y: m.m42 + b / 2, s: b * m.a };
}

export function openDetail(i: number, from: Spot, viaLens = false, src: '' | 'search' = ''): void {
  if (DT.open || DT.busy) return;
  hideHint(true);
  DT.open = true;
  DT.busy = true;
  DT.phase = 'opening';
  DT.from = src;
  DT.queue = 0;
  markSeen(i);
  closeLoupe(viaLens ? 'release' : 'now');
  stopCam();
  const lf = listFor(i);
  DT.list = lf.list;
  DT.ctx = lf.ctx;
  DT.ctxArea = lf.area;
  DT.idx = Math.max(0, DT.list.indexOf(i));
  DT.i = i;
  F.detailI = i;
  DT.rot.snap(0);
  setExpanded(false);
  startCopy(i);
  fillDetail(i);
  recordOpenPiece(i);
  flags.dirty = true;
  kick();
  els.pieceSlide.style.opacity = '0';
  els.tt.classList.remove('is-loading', 'is-live');
  els.detail.classList.remove('is-floating');
  els.detail.classList.add('is-open');
  els.detail.setAttribute('aria-hidden', 'false');
  els.app.classList.add('is-detailing');
  focusInto(els.detail, q<HTMLElement>('[data-act="close"]'));
  applyPieceTilt();
  syncHistory();
  els.toast.classList.remove('is-show');
  const r = rectOf(els.pieceSlide);
  if (motion.reduced || !DT.src) {
    els.pieceSlide.style.opacity = '1';
    els.pieceSlide.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150 });
    finishOpening();
    return;
  }
  const a = fly(DT.src, from, { x: r.x + r.w / 2, y: r.y + r.h / 2, s: r.w }, 440, 'cubic-bezier(.32,.72,0,1)');
  DT.anim = a;
  a.finished
    .then(() => {
      if (DT.anim !== a || DT.phase !== 'opening') return;
      DT.anim = null;
      els.pieceSlide.style.opacity = '1';
      els.flyer.style.visibility = 'hidden';
      a.cancel();
      finishOpening();
    })
    .catch(() => undefined);
}

function finishOpening(): void {
  DT.phase = 'open';
  DT.busy = false;
  els.detail.classList.add('is-floating');
  requestAnimationFrame(() => {
    els.tt.classList.add('is-loading');
    window.setTimeout(() => {
      if (DT.open) els.tt.classList.add('is-live');
    }, 820);
  });
  if (DT.queue) {
    const qd = DT.queue;
    DT.queue = 0;
    swapTo(DT.idx + qd, qd);
  }
}

/** Closes the detail. `gone`: its piece has left the field, so the picture
 *  fades where it is instead of flying to a cell no longer its own. */
export function closeDetail(gone = false): void {
  if (!DT.open || DT.phase === 'closing') return;
  const i = DT.i;
  const src = DT.src;
  const opening = DT.phase === 'opening' && DT.anim;
  els.stageInner.querySelectorAll('.is-ghost').forEach((g) => g.remove());
  els.pieceSlide.getAnimations().forEach((a) => a.cancel());
  let from: Spot;
  if (opening && DT.anim) {
    from = flyerNow();
    DT.anim.cancel();
    DT.anim = null;
  } else {
    const r = rectOf(els.pieceSlide);
    const f = new DOMMatrix(getComputedStyle(els.pieceFloat).transform);
    from = { x: r.x + r.w / 2, y: r.y + r.h / 2 + f.m42 * (r.w / (els.pieceSlide.offsetWidth || r.w)), s: r.w };
  }
  DT.phase = 'closing';
  DT.closing = true;
  clearOpenPiece();
  DT.busy = true;
  sheetDrag = null;
  DT.queue = 0;
  let to: Spot | null = null;
  let thumb: HTMLElement | null = null;
  if (gone) {
    F.detailI = -1;
    to = { x: from.x, y: from.y, s: from.s * 0.6 };
  } else if (DT.from === 'search') {
    reopenSearch();
    thumb = searchThumb(i);
    if (thumb) {
      thumb.style.visibility = 'hidden';
      const tr = rectOf(thumb);
      to = { x: tr.x + tr.w / 2, y: tr.y + tr.h / 2, s: tr.w };
    }
  }
  if (!to) {
    const { px, py } = F.layout;
    let x = sx(px[i]!);
    let y = sy(py[i]!);
    if (x < 30 || x > view.W - 30 || y < TOPI + 20 || y > view.H - BOTI - 20) {
      cam.y = framePiece(i);
      camMoved();
      x = sx(px[i]!);
      y = sy(py[i]!);
    }
    to = { x, y, s: Math.max(pieceSize(cam.s), 10) };
  }
  syncHistory();
  focusBack(els.detail, thumb?.closest('button'));
  els.detail.classList.remove('is-open', 'is-floating');
  els.detail.setAttribute('aria-hidden', 'true');
  els.app.classList.remove('is-detailing');
  els.pieceSlide.style.opacity = '0';
  const done = (): void => {
    clearDetail();
    els.flyer.style.visibility = 'hidden';
    if (thumb) thumb.style.visibility = '';
    DT.open = false;
    DT.busy = false;
    DT.closing = false;
    DT.phase = '';
    F.detailI = -1;
    setExpanded(false);
    syncHistory();
    if (!thumb && !gone) F.flash.set(i, performance.now());
    flags.dirty = true;
    kick();
    haptic('tick');
    flushToast();
  };
  if (motion.reduced) {
    done();
    return;
  }
  if (!src) {
    done();
    return;
  }
  const a = fly(src, from, to, opening ? 320 : 380, 'cubic-bezier(.32,.72,0,1)');
  if (gone) els.flyer.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, easing: 'ease-in', fill: 'forwards' });
  a.finished
    .then(() => {
      a.cancel();
      els.flyer.getAnimations().forEach((x) => x.cancel());
      done();
    })
    .catch(() => undefined);
}

/** The piece `dir` along from the open one: the arrows, a sideways swipe on
 *  the sheet and the arrow keys all page this way, round at either end. */
export function pageBy(dir: 1 | -1): void {
  swapTo(DT.idx + dir, dir);
}

/** One cross-slide: the old piece leaves while the new one arrives. Past
 *  either end of the list it goes round. */
function swapTo(idx: number, dir: number, jump = false): void {
  if (!DT.open || DT.closing || (DT.list.length < 2 && !jump)) return;
  if (DT.busy) {
    DT.queue = dir;
    return;
  }
  DT.busy = true;
  DT.idx = wrapIndex(idx, DT.list.length);
  const i = DT.list[DT.idx]!;
  const ghost = els.pieceSlide.cloneNode(true) as HTMLElement;
  ghost.removeAttribute('id');
  ghost.classList.add('is-ghost');
  const gf = ghost.querySelector<HTMLElement>('.grid-piece-float');
  if (gf) gf.style.transform = getComputedStyle(els.pieceFloat).transform;
  els.stageInner.appendChild(ghost);
  DT.i = i;
  F.detailI = i;
  DT.rot.snap(0);
  startCopy(i);
  fillDetail(i);
  recordOpenPiece(i);
  applyPieceTilt();
  flags.dirty = true;
  kick();
  els.tt.classList.remove('is-loading', 'is-live');
  els.tt.getBoundingClientRect();
  els.tt.classList.add('is-loading');
  window.setTimeout(() => {
    if (DT.open && DT.i === i) els.tt.classList.add('is-live');
  }, 820);
  const move = !motion.reduced;
  const x = 110 * dir;
  ghost
    .animate(
      move
        ? [
            { transform: 'none', opacity: 1 },
            { transform: `translateX(${-x}px) scale(.9)`, opacity: 0 },
          ]
        : [{ opacity: 1 }, { opacity: 0 }],
      { duration: move ? 220 : 150, easing: 'cubic-bezier(.4,0,1,1)', fill: 'forwards' },
    )
    .finished.then(() => ghost.remove())
    .catch(() => undefined);
  els.pieceSlide
    .animate(
      move
        ? [
            { transform: `translateX(${x}px) scale(.9)`, opacity: 0 },
            { transform: 'none', opacity: 1 },
          ]
        : [{ opacity: 0 }, { opacity: 1 }],
      { duration: move ? 300 : 150, easing: 'cubic-bezier(.2,.9,.25,1)' },
    )
    .finished.then(() => {
      DT.busy = false;
      if (DT.queue) {
        const qd = DT.queue;
        DT.queue = 0;
        swapTo(DT.idx + qd, qd);
      }
    })
    .catch(() => {
      DT.busy = false;
    });
  els.sheetBody.animate([{ opacity: 0.15 }, { opacity: 1 }], { duration: 150, easing: 'ease-out' });
  haptic('tick');
}

/** Jump to piece m, paging within its own list from then on: a list of one
 *  still takes the jump. */
function jumpTo(m: number): void {
  if (DT.busy || m === DT.i) return;
  const lf = listFor(m);
  const idx = lf.list.indexOf(m);
  if (idx < 0) return;
  DT.list = lf.list;
  DT.ctx = lf.ctx;
  DT.ctxArea = lf.area;
  swapTo(idx, 1, true);
}

/** Refreshes an open detail after the field changed; a credit pointed at
 *  another collection has a new cell, and the page follows it there. */
export function refreshDetail(): void {
  if (!DT.open || DT.closing) return;
  // The credit whose page shows may have moved to another square (its
  // collection changed) or become the player's (its NFT minted): the page follows it,
  // or settles on the square's own page.
  const follow = DT.copyHash || (isShown(DT.i) ? '' : DT.hash);
  if (follow && !F.pieces[DT.i]?.credits.some((e) => e.hashHex === follow)) {
    const moved = F.pieces.findIndex((p) => p.credits.some((e) => e.hashHex === follow));
    if (moved >= 0) {
      DT.i = moved;
      F.detailI = moved;
      flags.dirty = true;
      kick();
    } else if (!isShown(DT.i)) {
      closeDetail(true);
      return;
    } else {
      DT.copy = 0;
      DT.copyHash = '';
    }
  }
  const lf = listFor(DT.i);
  DT.list = lf.list;
  DT.ctx = lf.ctx;
  DT.ctxArea = lf.area;
  DT.idx = Math.max(0, DT.list.indexOf(DT.i));
  fillDetail(DT.i);
}

/** Room kept under the head's last line in peek. */
const PEEK_BOTTOM = 44;

/** Fits peek: the sheet rises as far as its head needs, and the stage scales
 *  down by as much, so the piece stays clear of it. */
export function fitPeek(): void {
  if (DT.expanded) return;
  let rise = 0;
  if (!DT.land) {
    const more = q<HTMLElement>('.grid-d-more');
    const last = more.hidden ? q<HTMLElement>('.grid-d-head') : more;
    const bottom = last.getBoundingClientRect().bottom - els.sheet.getBoundingClientRect().top;
    rise = clamp(Math.ceil(bottom + PEEK_BOTTOM - DT.geo.peekH), 0, DT.geo.off);
  }
  const stageH = Math.max(1, DT.geo.stageH);
  DT.rise = rise;
  DT.pk = clamp((stageH - rise) / stageH, 0.1, 1);
  els.app.style.setProperty('--sheet-rise', `${String(rise)}px`);
  els.app.style.setProperty('--peek-k', DT.pk.toFixed(3));
}

/** How far peek slides the sheet down. */
const peekOff = (): number => DT.geo.off - DT.rise;
const sheetY = (): number => (DT.expanded ? 0 : peekOff());
let sheetDrag: {
  id: number;
  x0: number;
  y0: number;
  lock: 'h' | 'v' | null;
  base: number;
  grab: boolean;
  top: boolean;
  vy: number;
  ly: number;
  lt: number;
} | null = null;

function releaseDrag(): void {
  els.stageInner.classList.remove('is-dragging');
  els.sheet.classList.remove('is-dragging');
  els.stageInner.style.transform = '';
  els.sheet.style.transform = '';
}

export function attachDetail(): void {
  els.detail.classList.toggle('is-turned', deviceStore.getState().turned);
  const close = q<HTMLElement>('[data-act="close"]');
  on(close, 'click', () => closeDetail());
  on(q<HTMLElement>('[data-act="prev"]'), 'click', () => pageBy(-1));
  on(q<HTMLElement>('[data-act="next"]'), 'click', () => pageBy(1));
  // The copies on this square: the one you hold, then each credit.
  const stepCopy = (dir: number): void => {
    const pages = pagesOf(DT.i);
    const next = DT.copy + dir;
    if (!DT.open || next < 0 || next >= pages.length) return;
    const page = pages[next]!;
    DT.copy = next;
    DT.copyHash = page.kind === 'credit' ? page.entry.hashHex : '';
    haptic('tick');
    fillDetail(DT.i);
    els.sheetBody.animate([{ opacity: 0.15 }, { opacity: 1 }], { duration: 150, easing: 'ease-out' });
  };
  on(q<HTMLElement>('[data-act="copy-prev"]'), 'click', () => stepCopy(-1));
  on(q<HTMLElement>('[data-act="copy-next"]'), 'click', () => stepCopy(1));
  on(q<HTMLElement>('.grid-d-more'), 'click', () => setExpanded(true));
  // Expanded, the body scrolls natively (grid.css), but a pull down from its
  // top moves the sheet back to peek: the finger's first move decides, and
  // every move after it in that touch is the sheet's drag (model/sheet.ts).
  let pull: { y0: number; decided: boolean; held: boolean } | null = null;
  on(
    els.sheetBody,
    'touchstart',
    (e) => {
      const t = e.touches.length === 1 ? e.touches[0] : undefined;
      pull = t ? { y0: t.clientY, decided: false, held: false } : null;
    },
    { passive: true },
  );
  on(
    els.sheetBody,
    'touchmove',
    (e) => {
      const t = e.touches[0];
      if (!pull || !t) return;
      if (!pull.decided) {
        const dy = t.clientY - pull.y0;
        if (dy === 0) return;
        pull.decided = true;
        pull.held = pullsSheet(DT, els.sheetBody.scrollTop, dy);
      }
      if (pull.held && e.cancelable) e.preventDefault();
    },
    { passive: false },
  );
  const endPull = (): void => {
    pull = null;
  };
  on(els.sheetBody, 'touchend', endPull, { passive: true });
  on(els.sheetBody, 'touchcancel', endPull, { passive: true });

  // In peek, a wheel turned toward more opens the sheet, as a drag up does.
  on(
    els.sheet,
    'wheel',
    (e) => {
      if (DT.open && !DT.closing && wheelOpens(DT, e.deltaX, e.deltaY)) setExpanded(true);
    },
    { passive: true },
  );

  // The piece: drag sideways to turn it, pull down to close.
  on(els.stage, 'pointerdown', (e) => {
    if (!DT.open || DT.phase !== 'open' || (e.target as HTMLElement).closest('.grid-nav')) return;
    try {
      els.stage.setPointerCapture(e.pointerId);
    } catch {
      // released already
    }
    DT.drag = {
      id: e.pointerId,
      x0: e.clientX,
      y0: e.clientY,
      lock: null,
      r0: DT.rot.x,
      lx: e.clientX,
      lt: performance.now(),
      vx: 0,
    };
  });
  on(els.stage, 'pointermove', (e) => {
    const d = DT.drag;
    if (d?.id !== e.pointerId) return;
    const dx = e.clientX - d.x0;
    const dy = e.clientY - d.y0;
    if (!d.lock && Math.hypot(dx, dy) > 8) d.lock = Math.abs(dx) >= Math.abs(dy) ? 'h' : dy > 0 ? 'v' : 'h';
    const now = performance.now();
    d.vx = ((e.clientX - d.lx) / Math.max(1, now - d.lt)) * 1000;
    d.lx = e.clientX;
    d.lt = now;
    if (d.lock === 'h') {
      let r = d.r0 + dx * 0.45;
      if (Math.abs(r) > 50) r = Math.sign(r) * (50 + (Math.abs(r) - 50) * 0.25);
      DT.rot.snap(r);
      applyPieceTilt();
    } else if (d.lock === 'v') {
      const p = Math.max(0, dy);
      els.stageInner.classList.add('is-dragging');
      els.sheet.classList.add('is-dragging');
      els.stageInner.style.transform = `translateY(${p * 0.6}px) scale(${(DT.expanded ? DT.geo.k : DT.pk) * (1 - p / 1600)})`;
      els.sheet.style.transform = `translateY(${sheetY() + p * 0.4}px)`;
    }
  });
  const endStage = (e: PointerEvent): void => {
    const d = DT.drag;
    if (d?.id !== e.pointerId) return;
    DT.drag = null;
    if (d.lock === 'h') {
      if (!els.detail.classList.contains('is-turned')) {
        els.detail.classList.add('is-turned');
        deviceStore.setState({ turned: true });
      }
      if (motion.reduced) DT.rot.snap(0);
      else {
        DT.rot.v = d.vx * 0.25;
        DT.rot.set(0);
      }
      applyPieceTilt();
      kick();
    } else if (d.lock === 'v') {
      const p = e.clientY - d.y0;
      releaseDrag();
      if (p > 110 && e.type === 'pointerup') closeDetail();
    }
  };
  on(els.stage, 'pointerup', endStage);
  on(els.stage, 'pointercancel', endStage);

  // The sheet: drag between peek, expanded and closed; swipe sideways to page.
  on(els.sheet, 'pointerdown', (e) => {
    if (!DT.open || DT.closing) return;
    const now = performance.now();
    sheetDrag = {
      id: e.pointerId,
      x0: e.clientX,
      y0: e.clientY,
      lock: null,
      base: sheetY(),
      grab: Boolean((e.target as HTMLElement).closest('.grid-grab-zone')),
      top: els.sheetBody.scrollTop <= 0,
      vy: 0,
      ly: e.clientY,
      lt: now,
    };
  });
  on(els.sheet, 'pointermove', (e) => {
    const g = sheetDrag;
    if (g?.id !== e.pointerId) return;
    const dx = e.clientX - g.x0;
    const dy = e.clientY - g.y0;
    const now = performance.now();
    g.vy = lerp(g.vy, ((e.clientY - g.ly) / Math.max(1, now - g.lt)) * 1000, 0.5);
    g.ly = e.clientY;
    g.lt = now;
    if (!g.lock && Math.hypot(dx, dy) > 8) {
      g.lock = Math.abs(dx) > Math.abs(dy) * 1.2 ? 'h' : 'v';
      if (g.lock === 'v' && (DT.land || (DT.expanded && !g.grab && !(g.top && dy > 0)))) {
        sheetDrag = null;
        return;
      }
      if (g.lock === 'v') {
        try {
          els.sheet.setPointerCapture(e.pointerId);
        } catch {
          // released already
        }
        els.sheet.classList.add('is-dragging');
        els.stageInner.classList.add('is-dragging');
      }
    }
    if (g.lock === 'v') {
      const off = peekOff();
      let y = g.base + dy;
      if (y < 0) y *= 0.3;
      if (!DT.info && y < off) y = off - (off - y) * 0.3;
      els.sheet.style.transform = `translateY(${y}px)`;
      const t = clamp(y / off, 0, 1);
      const k = lerp(DT.geo.k, DT.pk, t);
      const p = Math.max(0, y - off);
      els.stageInner.style.transform = `translateY(${p * 0.6}px) scale(${k * (1 - p / 1600)})`;
    }
  });
  const endSheet = (e: PointerEvent): void => {
    const g = sheetDrag;
    sheetDrag = null;
    if (g?.id !== e.pointerId) return;
    const dx = e.clientX - g.x0;
    const dy = e.clientY - g.y0;
    const cancel = e.type === 'pointercancel';
    if (g.lock === 'v') {
      releaseDrag();
      if (cancel) return;
      const y = g.base + dy;
      const v = g.vy;
      const off = peekOff();
      if (y > off + 110 || (y > off + 30 && v > 700)) {
        closeDetail();
        return;
      }
      setExpanded(v < -450 ? true : v > 450 ? false : y < off / 2);
      return;
    }
    if (cancel) return;
    if (g.lock === 'h') {
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) pageBy(dx < 0 ? 1 : -1);
      return;
    }
    if (g.grab) setExpanded(!DT.expanded);
  };
  on(els.sheet, 'pointerup', endSheet);
  on(els.sheet, 'pointercancel', endSheet);
}
