// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// Pictures for the grid's canvases, by URL, checked against their content id
// like every picture (art/verifiedArt.ts). Each keeps a 64 px cell on a shared
// atlas, its average colour for the dot it shrinks to, and the empty space
// under it; full pictures stay for the 40 most recently drawn large (BIG_KEEP)
// and what is on screen. Loads run four at a time, pieces on screen first. Small copies are
// kept on the device and back on the atlas at launch (keptArtBack).

import { keepCells, type KeptCell, readCells } from '@/entities/art/artStore';
import { cidFromUrl, loadVerifiedArt } from '@/entities/art/verifiedArt';
import { isInContainer } from '@/shared/host/embed';

export const CELL = 64;
const PAGE = 2048;
const PER_ROW = PAGE / CELL;
const PER_PAGE = PER_ROW * PER_ROW;
const PARALLEL = 4;
/** Full pictures kept beyond what is on screen, the ceiling on them all, and
 *  how recently a piece must have been drawn big to count as on screen. */
const BIG_KEEP = 40;
const BIG_MAX = 120;
const BIG_FRESH_MS = 1_500;
const RETRY_MS = [4_000, 12_000];
/** A full picture asked for to draw big ranks with the pieces on screen. */
const BIG_PRIORITY = 3;
/** New small copies wait this long for the rest of their burst, then are kept
 *  in one write. */
const KEEP_AFTER_MS = 1_000;

export interface ArtCell {
  page: HTMLCanvasElement;
  sx: number;
  sy: number;
  /** "rgb(…)" lifted so dark art still reads as a dot. */
  color: string;
  /** Empty rows under the picture, as a fraction of its height. */
  gap: number;
}

interface Entry {
  url: string;
  /** kept: only its small copy is here, back from an earlier open; the full
   *  picture loads when something asks for it. */
  state: 'kept' | 'queued' | 'loading' | 'ready' | 'failed';
  priority: number;
  tries: number;
  cell?: ArtCell;
  /** The verified `blob:` URL, usable as an <img> src. */
  src?: string;
  big?: HTMLImageElement;
  /** When the full picture was last drawn, and whether it is on its way back
   *  after being let go. */
  bigAt?: number;
  bigPending?: boolean;
  silhouette?: { color: string; canvas: HTMLCanvasElement };
}

const entries = new Map<string, Entry>();
const pages: HTMLCanvasElement[] = [];
let slots = 0;
let running = 0;
const bigOrder: string[] = [];
let onChange: () => void = () => undefined;
/** Small copies made this session, waiting to be kept. */
const toKeep: KeptCell[] = [];
let keepTimer = 0;

/** Called whenever a picture lands, so the canvases redraw. */
export function onArtChange(fn: () => void): void {
  onChange = fn;
}

/** Ask for `url` with `priority` (higher first). Cheap to call every frame. */
export function wantArt(url: string | undefined, priority: number): void {
  if (!url) return;
  const hit = entries.get(url);
  if (hit) {
    if (hit.state === 'queued' && priority > hit.priority) hit.priority = priority;
    return;
  }
  entries.set(url, { url, state: 'queued', priority, tries: 0 });
  queueMicrotask(pump);
}

/** The atlas cell for `url`, once loaded. */
export const artCell = (url: string | undefined): ArtCell | undefined => (url ? entries.get(url)?.cell : undefined);

/** An <img> src for `url` once loaded, else undefined. */
export const artSrc = (url: string | undefined): string | undefined => (url ? entries.get(url)?.src : undefined);

/** The full picture for drawing big, or undefined until it is in. */
export function artBig(url: string | undefined): HTMLImageElement | undefined {
  if (!url) return undefined;
  const e = entries.get(url);
  if (!e) return undefined;
  e.bigAt = performance.now();
  if (!e.big) {
    if (e.src) restoreBig(e);
    else askFull(e, BIG_PRIORITY);
    return undefined;
  }
  const at = bigOrder.indexOf(url);
  if (at !== bigOrder.length - 1) {
    if (at >= 0) bigOrder.splice(at, 1);
    bigOrder.push(url);
  }
  return e.big;
}

/** Bring back the full picture of a piece whose picture was let go, from the
 *  src it loaded from, unless the ceiling leaves no room for it. */
function restoreBig(e: Entry): void {
  if (e.bigPending || !e.src) return;
  trimBigs();
  if (bigOrder.length >= BIG_MAX) return;
  e.bigPending = true;
  const img = new Image();
  img.decoding = 'async';
  img.src = e.src;
  img
    .decode()
    .then(() => {
      e.big = img;
      adoptBig(e);
      onChange();
    })
    .catch(() => undefined)
    .finally(() => {
      e.bigPending = false;
    });
}

/** Counts `e`'s full picture among the kept ones, letting go of the least
 *  recently drawn past BIG_KEEP; what is on screen stays, up to BIG_MAX. */
function adoptBig(e: Entry): void {
  if (!bigOrder.includes(e.url)) bigOrder.push(e.url);
  trimBigs();
}

function trimBigs(): void {
  const stale = performance.now() - BIG_FRESH_MS;
  for (let i = 0; bigOrder.length > BIG_KEEP && i < bigOrder.length;) {
    const old = entries.get(bigOrder[i]!);
    if (old && (old.bigAt ?? 0) > stale && bigOrder.length <= BIG_MAX) {
      i += 1;
      continue;
    }
    bigOrder.splice(i, 1);
    if (old) delete old.big;
  }
}

/** The picture's shape filled with `color`, for the lens. */
export function artSilhouette(url: string | undefined, color: string): HTMLCanvasElement | undefined {
  const e = url ? entries.get(url) : undefined;
  if (!e?.cell) return undefined;
  if (e.silhouette?.color === color) return e.silhouette.canvas;
  const c = document.createElement('canvas');
  c.width = c.height = CELL;
  const x = c.getContext('2d')!;
  x.drawImage(e.cell.page, e.cell.sx, e.cell.sy, CELL, CELL, 0, 0, CELL, CELL);
  x.globalCompositeOperation = 'source-in';
  x.fillStyle = color;
  x.fillRect(0, 0, CELL, CELL);
  e.silhouette = { color, canvas: c };
  return c;
}

/** Resolves with an <img> src for `url` once its full picture has loaded. */
export function whenArt(url: string, priority = 100): Promise<string | undefined> {
  wantArt(url, priority);
  const kept = entries.get(url);
  if (kept) askFull(kept, priority);
  return new Promise((resolve) => {
    const check = (): void => {
      const e = entries.get(url);
      if (!e || e.state === 'failed') resolve(undefined);
      else if (e.state === 'ready') resolve(e.src);
      else window.setTimeout(check, 60);
    };
    check();
  });
}

/** Resolves once `url` has its small copy, kept from an earlier open or made
 *  now: true, or false when its picture cannot be had. */
export function whenCell(url: string, priority = 100): Promise<boolean> {
  wantArt(url, priority);
  return new Promise((resolve) => {
    const check = (): void => {
      const e = entries.get(url);
      if (e?.cell) resolve(true);
      else if (!e || e.state === 'failed') resolve(false);
      else window.setTimeout(check, 60);
    };
    check();
  });
}

/** Load the full picture of a piece that has only its kept small copy. */
function askFull(e: Entry, priority: number): void {
  if (e.state !== 'kept') return;
  e.state = 'queued';
  e.priority = priority;
  queueMicrotask(pump);
}

function pump(): void {
  while (running < PARALLEL) {
    let next: Entry | undefined;
    for (const e of entries.values()) if (e.state === 'queued' && (!next || e.priority > next.priority)) next = e;
    if (!next) return;
    const e = next;
    e.state = 'loading';
    running += 1;
    void load(e).finally(() => {
      running -= 1;
      pump();
    });
  }
}

async function load(e: Entry): Promise<void> {
  try {
    const src = await loadVerifiedArt(e.url);
    if (!src) throw new Error('no verified picture');
    const img = new Image();
    img.decoding = 'async';
    img.src = src;
    await img.decode();
    e.src = src;
    if (!e.cell) {
      const { cell, pixels } = place(img);
      e.cell = cell;
      keep({ url: e.url, rgba: pixels, color: cell.color, gap: cell.gap });
    }
    e.big = img;
    adoptBig(e);
    e.state = 'ready';
    onChange();
  } catch {
    const delay = RETRY_MS[e.tries];
    e.tries += 1;
    e.state = 'failed';
    if (delay !== undefined)
      window.setTimeout(() => {
        e.state = 'queued';
        pump();
      }, delay);
  }
}

/** The next free cell on the atlas, on a new page when the last is full. */
function nextSlot(): { page: HTMLCanvasElement; sx: number; sy: number } {
  const n = slots++;
  const p = Math.floor(n / PER_PAGE);
  if (!pages[p]) {
    const c = document.createElement('canvas');
    c.width = c.height = PAGE;
    pages[p] = c;
  }
  const page = pages[p];
  const k = n % PER_PAGE;
  return { page, sx: (k % PER_ROW) * CELL, sy: Math.floor(k / PER_ROW) * CELL };
}

/** Draw `img` into the next atlas cell, halving down to 64 px for a clean
 *  small copy, and read its colour, foot gap and pixels. */
function place(img: HTMLImageElement): { cell: ArtCell; pixels: Uint8Array<ArrayBuffer> } {
  const { page, sx, sy } = nextSlot();
  let src: CanvasImageSource = img;
  let w = img.naturalWidth || CELL;
  while (w > CELL * 2) {
    const half = Math.max(CELL, Math.round(w / 2));
    const step = document.createElement('canvas');
    step.width = step.height = half;
    step.getContext('2d')!.drawImage(src, 0, 0, half, half);
    src = step;
    w = half;
  }
  const ctx = page.getContext('2d', { willReadFrequently: true })!;
  ctx.clearRect(sx, sy, CELL, CELL);
  ctx.drawImage(src, sx, sy, CELL, CELL);
  let color = 'rgb(150,150,160)';
  let gap = 0.05;
  const data = ctx.getImageData(sx, sy, CELL, CELL).data;
  const pixels = new Uint8Array(data.buffer);
  let r = 0;
  let g = 0;
  let b = 0;
  let wsum = 0;
  let lowest = -1;
  for (let y = 0; y < CELL; y++)
    for (let x = 0; x < CELL; x++) {
      const o = (y * CELL + x) * 4;
      const a = data[o + 3]! / 255;
      if (a > 0.08) lowest = y;
      r += data[o]! * a;
      g += data[o + 1]! * a;
      b += data[o + 2]! * a;
      wsum += a;
    }
  if (wsum > 0) {
    r /= wsum;
    g /= wsum;
    b /= wsum;
    const m = Math.max(r, g, b);
    const lift = m < 170 ? 170 / Math.max(1, m) : 1;
    color = `rgb(${Math.min(255, (r * lift) | 0)},${Math.min(255, (g * lift) | 0)},${Math.min(255, (b * lift) | 0)})`;
  }
  if (lowest >= 0) gap = (CELL - 1 - lowest) / CELL;
  return { cell: { page, sx, sy, color, gap }, pixels };
}

/** Keeps a small copy made now, with the others made around it. */
function keep(cell: KeptCell): void {
  if (!isInContainer) return;
  toKeep.push(cell);
  window.clearTimeout(keepTimer);
  keepTimer = window.setTimeout(keepNow, KEEP_AFTER_MS);
}

function keepNow(): void {
  window.clearTimeout(keepTimer);
  void keepCells(toKeep.splice(0));
}

/** A kept copy fit to draw: one cell of pixels, a colour that reads as one,
 *  a gap inside the cell, and a URL that names its content. */
const usableCell = (k: KeptCell): boolean =>
  k.rgba.byteLength === CELL * CELL * 4 &&
  /^rgb\(\d{1,3},\d{1,3},\d{1,3}\)$/.test(k.color) &&
  k.gap >= 0 &&
  k.gap <= 1 &&
  cidFromUrl(k.url) !== null;

/** Put the kept small copies back on the atlas: written as pixels, nothing
 *  to decode. A piece whose picture loaded first keeps its own. */
async function restoreKept(): Promise<void> {
  let restored = 0;
  for (const k of await readCells()) {
    if (!usableCell(k)) continue;
    const e = entries.get(k.url);
    if (e?.cell) continue;
    const { page, sx, sy } = nextSlot();
    const pixels = new Uint8ClampedArray(k.rgba.buffer, k.rgba.byteOffset, k.rgba.byteLength);
    page.getContext('2d', { willReadFrequently: true })!.putImageData(new ImageData(pixels, CELL, CELL), sx, sy);
    const cell: ArtCell = { page, sx, sy, color: k.color, gap: k.gap };
    if (e) e.cell = cell;
    else entries.set(k.url, { url: k.url, state: 'kept', priority: 0, tries: 0, cell });
    restored += 1;
  }
  if (restored > 0) onChange();
}

/** Settles once the small copies from earlier opens are back on the atlas, at
 *  once outside a host. Never rejects. */
export const keptArtBack: Promise<void> = isInContainer ? restoreKept().catch(() => undefined) : Promise.resolve();

// A copy made just before the app goes to the background is kept then, not
// lost with the page.
if (isInContainer) {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && toKeep.length > 0) keepNow();
  });
}
