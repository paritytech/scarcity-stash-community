// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// Drawing the grid: every collection a soft card with its title, count and tier
// labels; a missing piece a dot, a held one a coloured dot or, from the next
// step in, its picture with a shadow and, if rare, a holo halo. Close in, one
// line under each collection counts its missing pieces. With no collection to
// lay out, ghost cards fill the view.

import { artBig, artCell, CELL, wantArt } from '../art';
import { CARD_PAD, giveScale, GUTTER, inkOf, leftLine, pieceSize, STEPS } from '../model/grid';
import {
  BOTI,
  cam,
  els,
  F,
  filter,
  grid,
  isRare,
  isShown,
  motion,
  nameOf,
  ownUrl,
  sx,
  sy,
  tok,
  TOPI,
  view,
} from './core';
import { edge } from './edges';
import { fActive } from './filters';
import { cellSize, restStep } from './grid';
import { pinRegion } from './header';
import { exposedNow, frameStart, inViewReadable, isUnseen } from './seen';
import { tilt } from './tilt';
import { clamp, drawHalo, easeOut, fontPx, holo, roundRect, shadowBlob, UI_FONT } from './util';
import { drawBlooms } from './zero';

export const INTRO_MS = 900;

/** "12/47", or for a collection whose catalogue could not be read, "9 found":
 *  never a total the grid does not know. */
const regionCount = (r: number): string =>
  F.layout.regions[r]?.partial ? `${F.regionOwn[r] ?? 0} found` : `${F.regionOwn[r] ?? 0}/${F.regionTot[r] ?? 0}`;

/** Recount what each area and region has found. A credit with no NFT minted
 *  from it yet is counted on its own. */
export function refreshCounts(): void {
  const { areas, regions } = F.layout;
  F.areaOwn = new Int32Array(areas.length);
  F.areaMatch = new Int32Array(areas.length);
  F.regionOwn = new Int32Array(regions.length);
  F.regionTot = new Int32Array(regions.length);
  F.regionRecent = new Float64Array(regions.length).fill(-1);
  let found = 0;
  for (const a of areas) {
    let n = 0;
    for (let i = a.from; i < a.to; i++) {
      if (isShown(i)) {
        n++;
        F.regionRecent[a.region] = Math.max(F.regionRecent[a.region]!, F.pieces[i]?.foundAt ?? 0);
      }
    }
    F.areaOwn[a.idx] = n;
    F.regionOwn[a.region]! += n;
    F.regionTot[a.region]! += a.n;
    found += n;
  }
  F.foundCount = found;
}

const NEUTRAL = 'rgb(120,122,130)';
/** The bar's height: a collection title above this line is under the bar. */
const BAR_H = 60;
const CARD_RADIUS = 20;

/** A title bar's width as a share of the card's text room, card after card. */
const TITLE_BARS = [0.38, 0.26, 0.32];

/** A title's skeleton: a bar `w` wide on the baseline at (x, y), for a title `size` tall. */
function drawTitleBar(c: CanvasRenderingContext2D, x: number, y: number, w: number, size: number): void {
  const h = size * 0.6;
  roundRect(c, x, y - h, w, h, h / 2);
  c.fill();
}

/** A collection's title at (x, y) and its count after it. A name that does not fit
 *  shrinks, then drops its count, then trims. A name still being read is a bar. */
function drawTitle(c: CanvasRenderingContext2D, r: number, x: number, y: number, size: number, room: number): void {
  const region = F.layout.regions[r];
  const cnt = regionCount(r);
  c.font = fontPx(12, 600, UI_FONT);
  const cw = c.measureText(cnt).width + 8;
  let tw = room * TITLE_BARS[r % TITLE_BARS.length]!;
  if (region?.nameLoading) {
    c.fillStyle = tok.dot;
    drawTitleBar(c, x, y, tw, size);
  } else {
    const name = region?.name ?? '';
    let fs = size;
    c.font = fontPx(fs, 800);
    tw = c.measureText(name).width;
    if (tw + cw > room) {
      fs = Math.max(12, (fs * (room - cw)) / tw);
      c.font = fontPx(fs, 800);
      tw = c.measureText(name).width;
    }
    let t = name;
    if (tw > room) {
      while (t.length > 3 && c.measureText(`${t}…`).width > room) t = t.slice(0, -1);
      t += '…';
      tw = c.measureText(t).width;
    }
    c.fillStyle = tok.fg;
    c.fillText(t, x, y);
  }
  if (tw + cw <= room) {
    c.font = fontPx(12, 600, UI_FONT);
    c.fillStyle = tok.fg2;
    c.fillText(cnt, x + tw + 8, y);
  }
}

/** A missing piece's dot on a cell `w` wide. */
const dotRadius = (w: number): number => Math.max(1.6, w * 0.1);

/** Rows of dots in a ghost card. */
const GHOST_ROWS = 3;

/** Draws ghost cards down the view while there is no collection to lay out: a
 *  card, a bar for its title and rows of dots, sized as the resting step sizes them. */
function drawGhostCards(c: CanvasRenderingContext2D, sc: number, alpha: number): void {
  const step = STEPS[restStep()]!;
  const { x0, inner, pieceSide } = grid.layouts[restStep()]!;
  const pitch = pieceSide + step.gap;
  const cols = Math.round((inner + step.gap) / pitch);
  const cardW = view.W - 2 * GUTTER;
  const cardH = 2 * CARD_PAD + step.head + GHOST_ROWS * pitch - step.gap;
  const rad = dotRadius(pieceSide);
  c.globalAlpha = alpha;
  for (let k = 0, y = TOPI - sc; y < view.H; k++, y += cardH + step.sectionGap) {
    c.fillStyle = tok.region;
    roundRect(c, GUTTER, y, cardW, cardH, CARD_RADIUS);
    c.fill();
    c.fillStyle = tok.dot;
    const barW = (cardW - 2 * CARD_PAD) * TITLE_BARS[k % TITLE_BARS.length]!;
    drawTitleBar(c, GUTTER + CARD_PAD + 2, y + CARD_PAD + step.head * 0.72, barW, step.headSize);
    c.beginPath();
    for (let n = 0; n < GHOST_ROWS * cols; n++) {
      const x = x0 + (n % cols) * pitch + pieceSide / 2;
      const dotY = y + CARD_PAD + step.head + Math.floor(n / cols) * pitch + pieceSide / 2;
      c.moveTo(x + rad, dotY);
      c.arc(x, dotY, rad, 0, 6.2832);
    }
    c.fill();
  }
}

export function render(now: number): void {
  const c = els.field.getContext('2d')!;
  const { W, H, dpr } = view;
  const L = F.layout;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, W, H);
  // Pulled past either end, the whole frame gives a little about the
  // fingers, a few per cent at most: a limit, not one more step.
  if (grid.over !== 0) {
    const f = giveScale(grid.over);
    c.translate(grid.overX, grid.overY);
    c.scale(f, f);
    c.translate(-grid.overX, -grid.overY);
  }
  // Pulled past its top or bottom, the grid stretches away from that end
  // (engine/edges.ts).
  if (edge.stretch > 0) {
    const pivot = edge.side === 'top' ? TOPI : H - BOTI;
    c.translate(0, pivot);
    c.scale(1, 1 + edge.stretch);
    c.translate(0, -pivot);
  }
  const sc = cam.y * cam.s - H / 2;
  const intro = F.intro >= 0 ? (now - F.intro) / 1000 : 99;
  const ia = clamp(intro / 0.3, 0, 1);
  const fa = fActive();
  const rot = tilt.x.x * 40;
  const cardW = W - 2 * GUTTER;
  const textX = GUTTER + CARD_PAD + 2;
  const room = cardW - 2 * CARD_PAD - 4;
  c.textBaseline = 'alphabetic';
  c.textAlign = 'left';

  // Collections: a soft card each, its title and count at the top.
  for (const r of L.regions) {
    const sec = grid.sections[r.idx];
    if (!sec) continue;
    const y = sec.y - sc;
    if (y > H + 40 || y + sec.h < -40) continue;
    c.globalAlpha = ia;
    c.fillStyle = tok.region;
    roundRect(c, GUTTER, y, cardW, sec.h, CARD_RADIUS);
    c.fill();
    drawTitle(c, r.idx, textX, sec.titleY - sc, sec.size, room);
  }
  if (!L.regions.length) drawGhostCards(c, sc, ia);

  // Tier labels in a collection with more than one, with their counts or,
  // while filtering, their matches.
  for (const a of L.areas) {
    const t = grid.tiers[a.idx];
    if (!t || t.shown < 0.02) continue;
    const y = t.labelY - sc;
    if (y < -20 || y > H + 20) continue;
    c.globalAlpha = ia * t.shown;
    c.font = fontPx(t.size, 700);
    c.fillStyle = tok.fg2;
    c.fillText(a.name, textX, y);
    const tw = c.measureText(a.name).width + 6;
    c.font = fontPx(11, 500, UI_FONT);
    const m = F.areaMatch[a.idx] ?? 0;
    if (fa) {
      c.fillStyle = m ? tok.fg : tok.fg2;
      c.fillText(String(m), textX + tw, y);
    } else {
      const r = L.regions[a.region];
      c.fillText(r?.partial ? String(F.areaOwn[a.idx] ?? 0) : `${F.areaOwn[a.idx] ?? 0}/${a.n}`, textX + tw, y);
    }
  }
  // Close in, one line under a collection's pieces counts the ones still to
  // find; a collection whose catalogue could not be read has no count to
  // give.
  if (grid.words > 0.02) {
    c.globalAlpha = ia * grid.words;
    c.font = fontPx(12, 500, UI_FONT);
    c.fillStyle = tok.fg2;
    for (const r of L.regions) {
      const sec = grid.sections[r.idx];
      if (!sec?.left || r.partial) continue;
      const y = sec.leftY - sc;
      if (y < -20 || y > H + 20) continue;
      c.fillText(leftLine(sec.left), textX, y);
    }
  }
  c.globalAlpha = 1;

  // Dots and pieces, only the tiers and rows in view.
  const R = grid.rects;
  const dotsA: number[] = [];
  const dotsB: number[] = [];
  const pieces: number[] = [];
  for (const a of L.areas) {
    const t = grid.tiers[a.idx];
    if (!t || t.y - sc > H + 60 || t.y + t.h - sc < -60) continue;
    for (let i = a.from; i < a.to; i++) {
      const y = R[i * 4 + 1]! - sc;
      if (y > H + 60 || y + R[i * 4 + 3]! < -60) continue;
      if (isShown(i)) pieces.push(i);
      else (fa && filter.matchSet.has(i) ? dotsB : dotsA).push(i);
    }
  }
  const { px, py } = L;
  const introA = (i: number): number => {
    if (intro >= INTRO_MS / 1000) return 1;
    const d = Math.min(1, Math.hypot(sx(px[i]!) - F.introX, sy(py[i]!) - F.introY) / F.introR);
    return clamp((intro - d * 0.38) / 0.22, 0, 1);
  };
  const drawDots = (list: number[], color: string, grow: number, alpha: number): void => {
    c.fillStyle = color;
    c.globalAlpha = alpha;
    if (intro < INTRO_MS / 1000) {
      for (const i of list) {
        const a = introA(i);
        if (a <= 0) continue;
        c.globalAlpha = alpha * a;
        c.beginPath();
        c.arc(sx(px[i]!), sy(py[i]!), dotRadius(cellSize(i)) * grow, 0, 6.2832);
        c.fill();
      }
    } else {
      c.beginPath();
      for (const i of list) {
        const x = sx(px[i]!);
        const y = sy(py[i]!);
        const rad = dotRadius(cellSize(i)) * grow;
        c.moveTo(x + rad, y);
        c.arc(x, y, rad, 0, 6.2832);
      }
      c.fill();
    }
    c.globalAlpha = 1;
  };
  const f = filter.f;
  // Close in, the pieces still to find are counted in words: their dots go.
  const drawn = 1 - grid.words;
  if (drawn > 0.02) {
    drawDots(dotsA, tok.dot, 1, (fa && f.show !== 'missing' && !f.rare ? 0.45 : fa ? 0.5 : 1) * drawn);
    if (dotsB.length) drawDots(dotsB, tok.dotx, 1.55, drawn);
  }
  const names = grid.names;
  // Out at the dots every held piece is a dot in its colour; its picture
  // comes in as the grid moves to the next step.
  const dotted = grid.dots;
  frameStart();
  for (const i of pieces) {
    const x0 = sx(px[i]!);
    const y0 = sy(py[i]!);
    const ap = (F.appear[i] ?? 1) * introA(i);
    if (ap <= 0.01) continue;
    if (F.detailI === i) continue;
    const w = cellSize(i);
    const piece = pieceSize(w);
    const imgMode = piece >= 16 && dotted < 1;
    const blend = clamp((piece - 16) / 6, 0, 1) * (1 - dotted);
    const url = ownUrl(i);
    wantArt(url, 3);
    const art = artCell(url);
    const ink = inkOf(fa && !filter.matchSet.has(i), names);
    const dim = ink.piece;
    const depth = 1 + piece * 0.03;
    const x = x0 + tilt.x.x * depth;
    const y = y0 + tilt.y.x * depth;
    const sz = piece * ap;
    if (!imgMode || blend < 1) {
      const rr = Math.max(1.6, w * 0.4) * ap;
      c.globalAlpha = dim * (1 - blend);
      c.fillStyle = art?.color ?? NEUTRAL;
      c.beginPath();
      c.arc(x0, y0, rr, 0, 6.2832);
      c.fill();
    }
    if (imgMode) {
      const al = dim * blend;
      if (sz > 18) {
        c.globalAlpha = tok.shadowa * al * 0.8;
        const gap = art?.gap ?? 0.05;
        c.drawImage(shadowBlob(), x - sz * 0.36, y + sz * (0.5 - gap) - sz * 0.05, sz * 0.72, Math.max(3, sz * 0.13));
      }
      if (isRare(i)) drawHalo(c, x, y, sz * 0.62, rot, tok.haloa * al);
      c.globalAlpha = al;
      const big = sz * dpr > CELL * 1.2 ? artBig(url) : undefined;
      if (big) c.drawImage(big, x - sz / 2, y - sz / 2, sz, sz);
      else if (art) c.drawImage(art.page, art.sx, art.sy, CELL, CELL, x - sz / 2, y - sz / 2, sz, sz);
      else {
        // The picture is on its way: a soft disc where it will be. A piece
        // with no picture at all keeps a ringed disc, so it never looks like
        // it is still loading.
        c.globalAlpha = al * (url ? 0.35 : 0.6);
        c.fillStyle = tok.fg3;
        c.beginPath();
        c.arc(x, y, sz * 0.32, 0, 6.2832);
        c.fill();
        if (!url) {
          c.strokeStyle = tok.fg2;
          c.lineWidth = Math.max(1, sz * 0.03);
          c.stroke();
        }
      }
      // Something New and unseen, drawn in view: seen once it stays (seen.ts).
      if (dim >= 0.4 && isUnseen(i) && inViewReadable(i)) exposedNow(i);
      // Close in, every piece's name under it, as faint as the piece.
      if (ink.name > 0.02) {
        c.globalAlpha = ink.name;
        c.font = fontPx(12, 600, UI_FONT);
        c.fillStyle = tok.fg2;
        c.textAlign = 'center';
        c.fillText(ellipsize(c, nameOf(i), w + 8), x0, y0 + w / 2 + 16);
        c.textAlign = 'left';
      }
    }
    const fl = F.flash.get(i);
    if (fl !== undefined) {
      const k = (now - fl) / 700;
      if (k < 1) {
        c.globalAlpha = 1 - k;
        c.lineWidth = 2;
        const R0 = Math.max(sz, 12) / 2 + 4 + (motion.reduced ? 6 : easeOut(k) * 34);
        c.strokeStyle = holo(c, x0, y0, R0, 0);
        c.beginPath();
        c.arc(x0, y0, R0, 0, 6.2832);
        c.stroke();
      } else F.flash.delete(i);
    }
    const bt = F.burst.get(i);
    if (bt !== undefined) {
      const k = (now - bt) / 1000;
      if (k < 1) {
        const e = motion.reduced ? 0.5 : easeOut(k);
        const m = Math.max(sz, 14);
        drawHalo(c, x0, y0, m * (0.7 + e * 1.5), now / 5, (1 - k) * 0.95);
        c.globalAlpha = (1 - k) * 0.9;
        c.lineWidth = 2.5;
        const R1 = m / 2 + 8 + e * 54;
        c.strokeStyle = holo(c, x0, y0, R1, now / 4);
        c.beginPath();
        c.arc(x0, y0, R1, 0, 6.2832);
        c.stroke();
      } else F.burst.delete(i);
    }
  }
  drawBlooms(c, now);

  // The stepping focus pulse.
  if (F.focusI >= 0) {
    const k = (now - F.focusT) / 1400;
    if (k < 1) {
      const i = F.focusI;
      const x = sx(px[i]!);
      const y = sy(py[i]!);
      const R0 = Math.max(pieceSize(cellSize(i)), 14) / 2 + 6 + (motion.reduced ? 0 : Math.sin(k * Math.PI * 3) * 3);
      c.globalAlpha = k < 0.7 ? 1 : (1 - k) / 0.3;
      c.lineWidth = 2;
      c.strokeStyle = holo(c, x, y, R0, now / 8);
      c.beginPath();
      c.arc(x, y, R0, 0, 6.2832);
      c.stroke();
    } else F.focusI = -1;
  }
  c.globalAlpha = 1;
  pinRegion(pinnedRegion(sc));
}

/** The collection whose own title has scrolled under the bar while its card
 *  is still on screen below it, by region index; -1 when there is none. */
function pinnedRegion(sc: number): number {
  for (const r of F.layout.regions) {
    const sec = grid.sections[r.idx];
    if (sec && sec.titleY - sc <= BAR_H && sec.y + sec.h - sc > BAR_H) return r.idx;
  }
  return -1;
}

function ellipsize(c: CanvasRenderingContext2D, t: string, maxW: number): string {
  if (c.measureText(t).width <= maxW) return t;
  while (t.length > 3 && c.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
  return `${t}…`;
}
