// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// Small numeric and drawing helpers the grid's engine shares.

export const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
/** Cubic in-out. */
export const ease = (p: number): number => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
export const easeOut = (p: number): number => 1 - Math.pow(1 - p, 3);
/** A back-out with overshoot `k`: settles past 1 and returns. */
export const backOut = (p: number, k: number): number => {
  const q = p - 1;
  return 1 + (k + 1) * q * q * q + k * q * q;
};
export const wait = (ms: number): Promise<void> => new Promise((r) => window.setTimeout(r, ms));

/** A damped spring easing `x` toward its target `t`, in two half steps per frame
 *  for stability. */
export class Spring {
  x: number;
  v = 0;
  t: number;
  k: number;
  d: number;
  constructor(x: number, k = 170, d = 20) {
    this.x = x;
    this.t = x;
    this.k = k;
    this.d = d;
  }
  set(t: number): void {
    this.t = t;
  }
  snap(t: number): void {
    this.x = this.t = t;
    this.v = 0;
  }
  /** Advance by `dt` seconds; false once at rest. */
  step(dt: number): boolean {
    if (this.x === this.t && this.v === 0) return false;
    const h = dt / 2;
    for (let n = 0; n < 2; n++) {
      const a = this.k * (this.t - this.x) - this.d * this.v;
      this.v += a * h;
      this.x += this.v * h;
    }
    if (Math.abs(this.t - this.x) < 1e-3 && Math.abs(this.v) < 1e-2) {
      this.x = this.t;
      this.v = 0;
    }
    return true;
  }
}

/** The lens's fisheye: where an offset from the focus lands in the lens, and
 *  its scale there; `magnification` above 0 enlarges the centre more. */
export function fish(
  dx: number,
  dy: number,
  fieldRadius: number,
  lensRadius: number,
  magnification: number,
): { x: number; y: number; s: number; d: number } {
  const d = Math.hypot(dx, dy);
  const base = lensRadius / fieldRadius;
  if (d < 0.001) return { x: 0, y: 0, s: base * (1 + magnification), d: 0 };
  const u = d / fieldRadius;
  const g = ((1 + magnification) * u) / (1 + magnification * u);
  return {
    x: (dx / d) * lensRadius * g,
    y: (dy / d) * lensRadius * g,
    s: (base * (1 + magnification)) / Math.pow(1 + magnification * u, 2),
    d,
  };
}

const HOLO: readonly [number, string][] = [
  [0, '#8D8E8E'],
  [0.06, '#A5A5A6'],
  [0.11, '#B2B3B3'],
  [0.16, '#BFBFC0'],
  [0.21, '#CBCBCD'],
  [0.26, '#D6D7D9'],
  [0.31, '#DBDCDE'],
  [0.41, '#DCDEE0'],
  [0.46, '#D2D4E0'],
  [0.51, '#C5CDE5'],
  [0.54, '#C5D3ED'],
  [0.59, '#D4E3F0'],
  [0.63, '#DFE7EE'],
  [0.66, '#EEEEF0'],
  [0.71, '#F7F5F4'],
  [0.76, '#FAEDE2'],
  [0.81, '#F6DCC5'],
  [0.86, '#DFC7B2'],
  [0.91, '#BAAFAA'],
  [1, '#AEA6A5'],
];

/** The holo foil as a linear gradient across a circle of radius r. */
export function holo(c: CanvasRenderingContext2D, x: number, y: number, r: number, rot: number): CanvasGradient {
  const a = ((151 + rot) * Math.PI) / 180;
  const dx = Math.sin(a) * r;
  const dy = -Math.cos(a) * r;
  const g = c.createLinearGradient(x - dx, y - dy, x + dx, y + dy);
  for (const [o, col] of HOLO) g.addColorStop(o, col);
  return g;
}

/** A rounded rectangle path, square where roundRect is missing. */
export function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  c.beginPath();
  if (typeof c.roundRect === 'function') c.roundRect(x, y, w, h, r);
  else c.rect(x, y, w, h);
}

export const fontPx = (px: number, weight = 700, family = 'Manrope, system-ui, sans-serif'): string =>
  `${weight} ${px}px ${family}`;
export const UI_FONT = 'Inter, system-ui, sans-serif';

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

let haloCanvas: HTMLCanvasElement | null = null;
/** The holo halo behind rare pieces: the foil, faded out radially. */
function halo(): HTMLCanvasElement {
  if (haloCanvas) return haloCanvas;
  const [c, x] = canvas(128, 128);
  x.fillStyle = holo(x, 64, 64, 64, 0);
  x.fillRect(0, 0, 128, 128);
  x.globalCompositeOperation = 'destination-in';
  const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(0,0,0,.95)');
  g.addColorStop(0.55, 'rgba(0,0,0,.55)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 128, 128);
  haloCanvas = c;
  return c;
}

let blobCanvas: HTMLCanvasElement | null = null;
/** The soft contact shadow under a piece. */
export function shadowBlob(): HTMLCanvasElement {
  if (blobCanvas) return blobCanvas;
  const [c, x] = canvas(64, 16);
  const g = x.createRadialGradient(32, 8, 0, 32, 8, 32);
  g.addColorStop(0, 'rgba(0,0,0,1)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = g;
  x.save();
  x.scale(1, 0.25);
  x.fillRect(0, 0, 64, 64);
  x.restore();
  blobCanvas = c;
  return c;
}

export function drawHalo(c: CanvasRenderingContext2D, x: number, y: number, r: number, rot: number, a: number): void {
  c.save();
  c.globalAlpha = a;
  c.translate(x, y);
  c.rotate((rot * Math.PI) / 180);
  c.drawImage(halo(), -r, -r, r * 2, r * 2);
  c.restore();
}
