// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// The engine's shared state: the elements it drives, the view and camera, the
// field it draws, the frame loop's task list, and the lookups every part of
// the engine asks of a piece. One object per concern, mutated in place, so the
// frame loop reads it without allocating.

import type { OpenTarget } from '@/shared/lib/location';

import type { Area, FieldLayout, PieceState, Region } from '../model/field';
import { NO_FILTER, type Span } from '../model/filter';
import { DEFAULT_STEP, type GridLayout, type GridSection, type GridTier } from '../model/grid';

/** Every element the engine moves or writes, found once when it attaches. */
export interface Els {
  app: HTMLElement;
  fieldWrap: HTMLElement;
  field: HTMLCanvasElement;
  pieceList: HTMLElement;
  boot: HTMLElement;
  head: HTMLElement;
  title: HTMLElement;
  countLine: HTMLElement;
  roName: HTMLElement;
  roMeta: HTMLElement;
  stepbar: HTMLElement;
  stepName: HTMLElement;
  stepPos: HTMLElement;
  dock: HTMLElement;
  bNew: HTMLElement;
  nDot: HTMLElement;
  bFilter: HTMLElement;
  filtLbl: HTMLElement;
  touchDot: HTMLElement;
  holdRing: SVGSVGElement;
  holdArc: SVGCircleElement;
  loupe: HTMLElement;
  lens: HTMLCanvasElement;
  engTop: SVGTextPathElement;
  engBot: SVGTextPathElement;
  lensRead: HTMLElement;
  lrName: HTMLElement;
  lrMeta: HTMLElement;
  pill: HTMLElement;
  pillText: HTMLElement;
  orbs: HTMLElement;
  detail: HTMLElement;
  stage: HTMLElement;
  stageInner: HTMLElement;
  pieceSlide: HTMLElement;
  pieceFloat: HTMLElement;
  pieceTilt: HTMLElement;
  pieceImg: HTMLImageElement;
  sheen: HTMLElement;
  tt: HTMLElement;
  sheet: HTMLElement;
  sheetBody: HTMLElement;
  flyer: HTMLImageElement;
  search: HTMLElement;
  sInput: HTMLInputElement;
  sRes: HTMLElement;
  scrim: HTMLElement;
  collSheet: HTMLElement;
  filtSheet: HTMLElement;
  hist: HTMLElement;
  histCv: HTMLCanvasElement;
  hSum: HTMLElement;
  hMiss: HTMLElement;
  hNone: HTMLElement;
  wbot: HTMLElement;
  fShow: HTMLElement;
  fOnly: HTMLElement;
  fPreset: HTMLElement;
  fFit: HTMLButtonElement;
  hFrom: HTMLInputElement;
  hTo: HTMLInputElement;
  zcard: HTMLElement;
  hintCard: HTMLElement;
  toast: HTMLElement;
}

/** The grid's elements. The object stays the same, and attaching the grid
 *  fills it. */
export const els = {} as Els;
export function setEls(next: Els): void {
  Object.assign(els, next);
}

/** The view: the app's size in CSS pixels, its device pixel ratio and box. */
export const view = { W: 0, H: 0, dpr: 1, left: 0, top: 0 };

/** Insets the camera keeps clear for the header and the dock. */
export const TOPI = 72;
export const BOTI = 76;

/** The camera. Its scale is the grid's piece size at the step it is on
 *  (engine/grid.ts) and its y is the scroll; across, world x 0 is the left edge. */
export const cam = { y: 0, s: 22 };

/** The grid: the step it rests on or moves between (a fraction mid-pinch), the
 *  layout of every step at this width, and their blend at `z`. */
export const grid = {
  z: DEFAULT_STEP as number,
  layouts: [] as GridLayout[],
  /** Per cell: x, y, w and h. */
  rects: new Float32Array(0),
  sections: [] as GridSection[],
  tiers: [] as GridTier[],
  height: 0,
  /** How far in the steps are where every piece is a dot, where names show,
   *  and where the pieces still to find are counted in words. */
  dots: 0,
  names: 0,
  words: 0,
  /** How far a pinch pulls past the ends, -1 to 1, and the screen point it
   *  pulls from: the frame scales about it a little (model/grid.ts). */
  over: 0,
  overX: 0,
  overY: 0,
};

export const sx = (x: number): number => x * cam.s;
export const sy = (y: number): number => (y - cam.y) * cam.s + view.H / 2;
export const wx = (x: number): number => x / cam.s;
export const wy = (y: number): number => cam.y + (y - view.H / 2) / cam.s;

/** What needs drawing, and whether the engine is up. */
export const flags = {
  dirty: true,
  lensDirty: false,
  booted: false,
  attached: false,
  /** The screen a link asked for, until the first frame takes it. */
  target: null as OpenTarget | null,
  /** A field this session's reads delivered has landed, so an empty New is
   *  what the chain holds and not a read still on its way. */
  chainField: false,
};

/** Colours and alphas read from the stylesheet. */
export const tok = {
  bg: '#0B0C0F',
  nested: '#23252A',
  surface: '#1A1B20',
  dot: '#2E3036',
  dotx: '#6A6D75',
  region: 'rgba(255,255,255,.028)',
  fg: '#F4F4F5',
  fg2: '#8C8F98',
  fg3: '#585B62',
  lens: '#111216',
  lensdot: '#3C3E45',
  sil: '#D6DAE8',
  sila: 0.17,
  haloa: 0.5,
  shadowa: 0.7,
};

export function readTokens(): void {
  const cs = getComputedStyle(els.app);
  const g = (n: string, fallback: string): string => cs.getPropertyValue(n).trim() || fallback;
  const f = (n: string, fallback: number): number => parseFloat(cs.getPropertyValue(n)) || fallback;
  tok.bg = g('--bg', tok.bg);
  tok.nested = g('--nested', tok.nested);
  tok.surface = g('--surface', tok.surface);
  tok.dot = g('--dot', tok.dot);
  tok.dotx = g('--dotx', tok.dotx);
  tok.region = g('--region', tok.region);
  tok.fg = g('--fg', tok.fg);
  tok.fg2 = g('--fg2', tok.fg2);
  tok.fg3 = g('--fg3', tok.fg3);
  tok.lens = g('--lens', tok.lens);
  tok.lensdot = g('--lensdot', tok.lensdot);
  tok.sil = g('--sil', tok.sil);
  tok.sila = f('--sila', tok.sila);
  tok.haloa = f('--haloa', tok.haloa);
  tok.shadowa = f('--shadowa', tok.shadowa);
}

/** Reduced motion, kept live. */
export const motion = { reduced: false };

const EMPTY_LAYOUT: FieldLayout = {
  key: '',
  cells: [],
  areas: [],
  regions: [],
  px: new Float32Array(0),
  py: new Float32Array(0),
  areaOf: new Int16Array(0),
  index: new Map(),
};

/** The field on screen: its layout, its pieces and their per-cell drawing state. */
export const F = {
  layout: EMPTY_LAYOUT,
  pieces: [] as PieceState[],
  span: { first: null, last: -1 } as Span,
  /** Cells held back for an arrival still in the air: drawn as missing. */
  held: new Set<string>(),
  /** Per cell: 0 until its arrival lands, then grows to 1. */
  appear: new Float32Array(0),
  flash: new Map<number, number>(),
  burst: new Map<number, number>(),
  focusI: -1,
  focusT: 0,
  /** The intro reveal's clock: -2 armed, -1 done, else its start time. */
  intro: -1,
  introX: 0,
  introY: 0,
  introR: 1,
  /** Per area and region: found and matching counts, recomputed on change. */
  areaOwn: new Int32Array(0),
  areaMatch: new Int32Array(0),
  regionOwn: new Int32Array(0),
  regionTot: new Int32Array(0),
  /** Most recent find per region, for the collections sheet's Recent sort. */
  regionRecent: new Float64Array(0),
  /** Pieces held now, credits included. */
  foundCount: 0,
  /** The cell open in the detail view: not drawn on the field. */
  detailI: -1,
};

export const filter = {
  f: { ...NO_FILTER },
  matches: [] as number[],
  matchSet: new Set<number>(),
  stepIdx: -1,
};

// Lookups. A piece the player holds is "owned"; one a credit would mint into,
// drawn as if it were, is "credit"; both open their detail and show their name.
export const isOwned = (i: number): boolean =>
  F.pieces[i]?.status === 'owned' && !F.held.has(F.layout.cells[i]?.key ?? '');
export const isShown = (i: number): boolean => {
  const st = F.pieces[i]?.status;
  return (st === 'owned' || st === 'credit') && !F.held.has(F.layout.cells[i]?.key ?? '');
};
export const isRare = (i: number): boolean => F.layout.cells[i]?.rare ?? false;
/** Something here arrived in the last 12 hours, a held copy or a credit
 *  (model/field.ts). */
export const isNewP = (i: number): boolean => isShown(i) && (F.pieces[i]?.isNew ?? false);
export const nameOf = (i: number): string => F.pieces[i]?.look?.name ?? '';
/** The picture of the piece's own look: a held copy's, or the item a credit
 *  would mint. */
export const ownUrl = (i: number): string | undefined => F.pieces[i]?.look?.imageUrl;
/** The catalogue's picture for a cell, drawn only as a silhouette or in the
 *  empty-grid show. */
export const catUrl = (i: number): string | undefined => F.layout.cells[i]?.imageUrl;
export const foundAt = (i: number): Date | undefined => {
  const t = F.pieces[i]?.foundAt;
  return t === undefined ? undefined : new Date(t * 1000);
};
export const areaOfI = (i: number): Area | undefined => F.layout.areas[F.layout.areaOf[i] ?? -1];
export const regionOfA = (a: Area): Region | undefined => F.layout.regions[a.region];
/** An area in words: "Animals · Rare", or the collection alone when it has
 *  one tier. */
export const areaPlace = (a: Area): string => {
  const r = regionOfA(a);
  return r && r.areas.length > 1 ? `${r.name} \u00b7 ${a.name}` : (r?.name ?? a.name);
};
/** Where a piece lives, as text with Rare named once: "Animals · Rare". */
export const placeOf = (i: number): string => {
  const a = areaOfI(i);
  if (!a) return '';
  const r = regionOfA(a);
  if (r && r.areas.length > 1) return areaPlace(a);
  return isRare(i) ? `${r?.name ?? a.name} \u00b7 Rare` : (r?.name ?? a.name);
};

/** A task runs each frame until it returns false. */
export type Task = (now: number) => boolean;
export const tasks = new Set<Task>();
export const loop = { raf: 0, last: 0 };
let frameFn: FrameRequestCallback = () => undefined;
export function setFrame(fn: FrameRequestCallback): void {
  frameFn = fn;
}
export function kick(): void {
  if (!loop.raf && flags.attached) {
    loop.last = performance.now();
    loop.raf = requestAnimationFrame(frameFn);
  }
}

const unbinds: (() => void)[] = [];

type AnyEventMap = HTMLElementEventMap & WindowEventMap & DocumentEventMap;

/** addEventListener, undone by unbindAll. */
export function on<K extends keyof AnyEventMap>(
  el: EventTarget,
  type: K,
  fn: (e: AnyEventMap[K]) => void,
  opts?: AddEventListenerOptions,
): void {
  el.addEventListener(type, fn as EventListener, opts);
  unbinds.push(() => el.removeEventListener(type, fn as EventListener, opts));
}

export function onCleanup(fn: () => void): void {
  unbinds.push(fn);
}

export function unbindAll(): void {
  for (const off of unbinds.splice(0)) off();
}
