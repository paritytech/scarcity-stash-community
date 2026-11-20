// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// Small canvases showing a piece's atlas cell, for list rows (search, the
// collections sheet, the detail's "also found that day"). A thumb whose
// picture is still on its way draws itself when it lands.

import { artCell, CELL, wantArt } from '../art';
import { ownUrl } from './core';

const waiting = new Map<HTMLCanvasElement, number>();

export function drawThumb(c: HTMLCanvasElement, i: number, size: number): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  c.width = c.height = Math.round(size * dpr);
  c.style.width = c.style.height = `${size}px`;
  const url = ownUrl(i);
  const art = artCell(url);
  if (!art) {
    wantArt(url, 60);
    waiting.set(c, i);
    return;
  }
  waiting.delete(c);
  const x = c.getContext('2d')!;
  x.clearRect(0, 0, c.width, c.height);
  x.drawImage(art.page, art.sx, art.sy, CELL, CELL, 0, 0, c.width, c.height);
}

/** Pictures landed: draw any thumb that was waiting for one. */
export function redrawThumbs(): void {
  for (const [c, i] of [...waiting]) {
    if (!c.isConnected) {
      waiting.delete(c);
      continue;
    }
    if (artCell(ownUrl(i))) drawThumb(c, i, parseFloat(c.style.width) || 40);
  }
}
