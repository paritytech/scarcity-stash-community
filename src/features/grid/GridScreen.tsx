// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// The grid screen: every piece of every collection on one grid of collection
// cards, scrolled and zoomed in steps. React draws this markup once; the engine
// moves and fills it from then on, so a chain read never re-renders the screen.
// Elements the engine drives carry a data-el name.

import './grid.css';

import { memo, useLayoutEffect, useRef } from 'react';

import { type Els } from './engine/core';
import { HOME_TITLE } from './engine/header';
import { type GridHooks } from './engine/hooks';
import { attachGrid, detachGrid } from './engine/index';

const X_ICON = (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
  >
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);
const SEARCH_ICON = (size: number) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
  >
    <circle cx="11" cy="11" r="6.5" />
    <path d="M16 16l4.5 4.5" />
  </svg>
);
const CHEV = (d: string) => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d={d} />
  </svg>
);

function collect(root: HTMLElement): Els {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the caller names the element type the markup guarantees
  const pick = <T extends Element>(name: string): T => {
    const el = root.querySelector<T>(`[data-el="${name}"]`);
    if (!el) throw new Error(`grid element missing: ${name}`);
    return el;
  };
  return {
    app: root,
    fieldWrap: pick('fieldWrap'),
    field: pick('field'),
    pieceList: pick('pieceList'),
    boot: pick('boot'),
    head: pick('head'),
    title: pick('title'),
    countLine: pick('countLine'),
    roName: pick('roName'),
    roMeta: pick('roMeta'),
    stepbar: pick('stepbar'),
    stepName: pick('stepName'),
    stepPos: pick('stepPos'),
    dock: pick('dock'),
    bNew: pick('bNew'),
    nDot: pick('nDot'),
    bFilter: pick('bFilter'),
    filtLbl: pick('filtLbl'),
    touchDot: pick('touchDot'),
    holdRing: pick('holdRing'),
    holdArc: pick('holdArc'),
    loupe: pick('loupe'),
    lens: pick('lens'),
    engTop: pick('engTop'),
    engBot: pick('engBot'),
    lensRead: pick('lensRead'),
    lrName: pick('lrName'),
    lrMeta: pick('lrMeta'),
    pill: pick('pill'),
    pillText: pick('pillText'),
    orbs: pick('orbs'),
    detail: pick('detail'),
    stage: pick('stage'),
    stageInner: pick('stageInner'),
    pieceSlide: pick('pieceSlide'),
    pieceFloat: pick('pieceFloat'),
    pieceTilt: pick('pieceTilt'),
    pieceImg: pick('pieceImg'),
    sheen: pick('sheen'),
    tt: pick('tt'),
    sheet: pick('sheet'),
    sheetBody: pick('sheetBody'),
    flyer: pick('flyer'),
    search: pick('search'),
    sInput: pick('sInput'),
    sRes: pick('sRes'),
    scrim: pick('scrim'),
    collSheet: pick('collSheet'),
    filtSheet: pick('filtSheet'),
    hist: pick('hist'),
    histCv: pick('histCv'),
    hSum: pick('hSum'),
    hMiss: pick('hMiss'),
    hNone: pick('hNone'),
    wbot: pick('wbot'),
    fShow: pick('fShow'),
    fOnly: pick('fOnly'),
    fPreset: pick('fPreset'),
    fFit: pick('fFit'),
    hFrom: pick('hFrom'),
    hTo: pick('hTo'),
    zcard: pick('zcard'),
    hintCard: pick('hintCard'),
    toast: pick('toast'),
  };
}

interface GridScreenProps {
  hooks: GridHooks;
  /** A read from the chain failed or is late, and is tried again: show it, quietly. */
  readsFailing: boolean;
  /** The device has no network: what is on the grid is all there is until it
   *  comes back. */
  offline: boolean;
}

function GridScreen({ hooks, readsFailing, offline }: GridScreenProps) {
  const rootRef = useRef<HTMLDivElement>(null);

  const hooksRef = useRef(hooks);
  useLayoutEffect(() => {
    hooksRef.current = hooks;
  });
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const els = collect(root);
    attachGrid(els, {
      opened: (kept, target) => hooksRef.current.opened(kept, target),
    });
    return () => detachGrid();
  }, []);

  return (
    <div className="grid-app" ref={rootRef}>
      <main className="grid-field-wrap" data-el="fieldWrap">
        <canvas className="grid-field" data-el="field" role="img" aria-label="Collectibles grid" />
        <ul className="grid-sr" data-el="pieceList" aria-label="Your pieces" />
      </main>
      <div className="grid-boot" data-el="boot" role="status">
        <span className="ui-spin" />
        <span className="grid-boot-text">Opening your collection</span>
      </div>

      <header className="grid-top">
        <div className="grid-bar">
          <span className="grid-bar-gap" aria-hidden="true" />
          <div className="grid-ttl" data-el="head">
            <div className="grid-layer grid-info">
              <b className="grid-title" data-el="title">
                {HOME_TITLE}
              </b>
              <small>
                <span className="grid-count-line" data-el="countLine">
                  &nbsp;
                </span>
              </small>
            </div>
            <div className="grid-layer grid-readout">
              <b data-el="roName">&nbsp;</b>
              <small data-el="roMeta">&nbsp;</small>
            </div>
          </div>
          <button type="button" className="ui-icon" data-act="search" aria-label="Search">
            {SEARCH_ICON(19)}
          </button>
        </div>
      </header>
      {(readsFailing || offline) && (
        <p className="grid-refresh-note" role="status">
          {offline ? 'Offline. Showing your collection from earlier.' : 'Trouble connecting. Retrying automatically.'}
        </p>
      )}

      <div className="grid-zoomrail">
        <button type="button" className="ui-icon" data-act="zoom-in" aria-label="Zoom in">
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
        <button type="button" className="ui-icon" data-act="zoom-out" aria-label="Zoom out">
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <path d="M5 12h14" />
          </svg>
        </button>
      </div>
      <div className="grid-stepbar" data-el="stepbar" role="toolbar" aria-label="Step through matches">
        <b data-el="stepName">Rare</b>
        <button type="button" data-act="step-prev" aria-label="Previous match">
          {CHEV('M15 5l-7 7 7 7')}
        </button>
        <span className="grid-step-pos" data-el="stepPos">
          &nbsp;
        </span>
        <button type="button" data-act="step-next" aria-label="Next match">
          {CHEV('M9 5l7 7-7 7')}
        </button>
        <button type="button" data-act="step-clear" aria-label="Clear filter">
          {X_ICON}
        </button>
      </div>
      <nav className="grid-dock" data-el="dock" aria-label="Grid controls">
        <button type="button" className="grid-dockbtn" data-act="coll" aria-haspopup="dialog">
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
          >
            <rect x="4" y="4" width="7" height="7" rx="2" />
            <rect x="13" y="4" width="7" height="7" rx="2" />
            <rect x="4" y="13" width="7" height="7" rx="2" />
            <rect x="13" y="13" width="7" height="7" rx="2" />
          </svg>
          <span>Collections</span>
        </button>
        <button type="button" className="grid-dockbtn grid-dockbtn--new" data-el="bNew" aria-pressed="false">
          <span>New</span>
          <i className="grid-ndot" data-el="nDot" aria-hidden="true" />
        </button>
        <button type="button" className="grid-dockbtn" data-el="bFilter" aria-haspopup="dialog">
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M4 6h16M7 12h10M10 18h4" />
          </svg>
          <span data-el="filtLbl">Filter</span>
        </button>
      </nav>

      <div className="grid-touch-dot" data-el="touchDot" />
      <svg className="grid-hold-ring" data-el="holdRing" width="56" height="56" viewBox="0 0 56 56" aria-hidden="true">
        <circle data-el="holdArc" cx="28" cy="28" r="25" pathLength={100} />
      </svg>
      <div className="grid-loupe" data-el="loupe" aria-hidden="true">
        <div className="grid-lens-shadow" />
        <canvas className="grid-lens" data-el="lens" width="220" height="220" />
        <div className="grid-lens-glass" />
        <div className="grid-bezel" />
        <div className="grid-bezel-shade" />
        <svg className="grid-engrave" viewBox="0 0 252 252" width="252" height="252">
          <defs>
            <path id="grid-eng-top" d="M 13 126 A 113 113 0 0 1 239 126" />
            <path id="grid-eng-bot" d="M 5 126 A 121 121 0 0 0 247 126" />
          </defs>
          <text>
            <textPath href="#grid-eng-top" startOffset="50%" textAnchor="middle" data-el="engTop" />
          </text>
          <text>
            <textPath href="#grid-eng-bot" startOffset="50%" textAnchor="middle" data-el="engBot" />
          </text>
        </svg>
      </div>
      <div className="grid-lens-read" data-el="lensRead" aria-hidden="true">
        <b data-el="lrName" />
        <small data-el="lrMeta" />
      </div>
      <button type="button" className="grid-pill" data-el="pill" aria-live="polite">
        <span className="ui-spin" />
        <span data-el="pillText" />
      </button>
      <div className="grid-orbs" data-el="orbs" aria-hidden="true" />

      <section
        className="grid-detail"
        data-el="detail"
        role="dialog"
        aria-modal="true"
        aria-labelledby="grid-d-name"
        aria-hidden="true"
      >
        <div className="grid-d-top">
          <button type="button" className="ui-icon" data-act="close" aria-label="Back to the grid">
            {CHEV('M6 9l6 6 6-6')}
          </button>
          <span className="grid-pager" />
          <span className="grid-bar-gap" aria-hidden="true" />
        </div>
        <div className="grid-stage" data-el="stage">
          <div className="grid-stage-inner" data-el="stageInner">
            <div className="grid-tt" data-el="tt">
              <div className="grid-tt-floor" />
              <svg viewBox="0 0 100 24">
                <defs>
                  <linearGradient id="grid-holo-g" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0" stopColor="#8D8E8E" />
                    <stop offset=".3" stopColor="#DCDEE0" />
                    <stop offset=".52" stopColor="#C5D3ED" />
                    <stop offset=".7" stopColor="#F7F5F4" />
                    <stop offset=".82" stopColor="#F6DCC5" />
                    <stop offset="1" stopColor="#AEA6A5" />
                  </linearGradient>
                </defs>
                <ellipse className="grid-tt-rim" cx="50" cy="12" rx="49" ry="11.5" />
                <ellipse className="grid-tt-prog" cx="50" cy="12" rx="49" ry="11.5" pathLength={100} />
              </svg>
            </div>
            <div className="grid-rare-glow" aria-hidden="true" />
            <div className="grid-piece-slide" data-el="pieceSlide">
              <div className="grid-piece-float" data-el="pieceFloat">
                <div className="grid-piece-tilt" data-el="pieceTilt">
                  <img data-el="pieceImg" alt="" />
                  <div className="grid-sheen" data-el="sheen" />
                </div>
              </div>
            </div>
            <div className="grid-turn-hint">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M3 12a9 4 0 0 0 15 3" />
                <path d="M21 12a9 4 0 0 0-15-3" />
                <path d="M16 17l2-2-2-2" />
                <path d="M8 7L6 9l2 2" />
              </svg>
              Drag to turn
            </div>
          </div>
          <button type="button" className="ui-icon grid-nav grid-nav--prev" data-act="prev" aria-label="Previous piece">
            {CHEV('M15 5l-7 7 7 7')}
          </button>
          <button type="button" className="ui-icon grid-nav grid-nav--next" data-act="next" aria-label="Next piece">
            {CHEV('M9 5l7 7-7 7')}
          </button>
        </div>
        <div className="grid-sheet" data-el="sheet">
          <div className="grid-grab-zone" aria-hidden="true">
            <div className="grid-grab" />
          </div>
          <div className="grid-sheet-body" data-el="sheetBody">
            <div className="grid-d-head">
              <h2 className="grid-d-name" id="grid-d-name" />
              <div className="grid-d-step" hidden>
                <button type="button" className="ui-icon" data-act="copy-prev" aria-label="Previous copy">
                  {CHEV('M15 5l-7 7 7 7')}
                </button>
                <span className="grid-d-stepn" aria-live="polite" />
                <button type="button" className="ui-icon" data-act="copy-next" aria-label="Next copy">
                  {CHEV('M9 5l7 7-7 7')}
                </button>
              </div>
              <div className="grid-d-path" />
              <div className="grid-d-chips">
                <span className="grid-rchip">Rare</span>
                <span className="grid-d-own" />
              </div>
              <p className="grid-d-desc" />
              <button type="button" className="grid-d-more" aria-label="More about this piece">
                More
              </button>
            </div>
            <div className="grid-d-extra">
              <h3 className="grid-d-about-h">About</h3>
              <dl className="grid-about" />
              <div className="grid-d-copybox">
                <h3>Your copy</h3>
                <p className="grid-d-copy" />
              </div>
            </div>
            <div className="grid-with" />
          </div>
        </div>
      </section>
      <img className="grid-flyer" data-el="flyer" alt="" />

      <section className="grid-search" data-el="search" aria-label="Search collectibles">
        <div className="grid-s-scrim" />
        <div className="grid-s-bar">
          <label className="ui-field">
            <span className="grid-sr">Search your pieces and collections</span>
            {SEARCH_ICON(18)}
            <input
              data-el="sInput"
              type="search"
              placeholder="Search your pieces and collections"
              autoComplete="off"
              enterKeyHint="search"
            />
          </label>
          <button type="button" className="ui-textbtn" data-act="cancel">
            Cancel
          </button>
        </div>
        <div className="grid-s-res" data-el="sRes" />
      </section>

      <div className="grid-scrim" data-el="scrim" />
      <section className="grid-psheet" data-el="collSheet" role="dialog" aria-label="Collections">
        <div className="grid-ph">
          <h3>Collections</h3>
          <button type="button" className="ui-icon ui-icon--sm" data-close="" aria-label="Close">
            {X_ICON}
          </button>
        </div>
        <label className="ui-field">
          <span className="grid-sr">Find a collection</span>
          {SEARCH_ICON(18)}
          <input type="search" placeholder="Find a collection" autoComplete="off" />
        </label>
        <div className="grid-seg grid-seg--sm">
          <button type="button" data-s="recent" aria-pressed="true">
            Recent
          </button>
          <button type="button" data-s="az" aria-pressed="false">
            A to Z
          </button>
          <button type="button" data-s="progress" aria-pressed="false">
            Progress
          </button>
        </div>
        <div className="grid-coll-list" />
      </section>
      <section className="grid-psheet" data-el="filtSheet" role="dialog" aria-label="Filter">
        <div className="grid-ph">
          <h3>Filter</h3>
          <button type="button" className="ui-icon ui-icon--sm" data-close="" aria-label="Close">
            {X_ICON}
          </button>
        </div>
        <div className="grid-chiprow">
          <span className="grid-contents" data-el="fShow">
            <button type="button" className="ui-chip" data-v="found" aria-pressed="false">
              Found
            </button>
            <button type="button" className="ui-chip" data-v="missing" aria-pressed="false">
              Missing
            </button>
          </span>
          <span className="grid-contents" data-el="fOnly">
            <button type="button" className="ui-chip" data-k="rare" aria-pressed="false">
              <span className="grid-hdot" />
              Rare
            </button>
          </span>
        </div>
        <div className="grid-wtop">
          <span className="grid-h-sum" data-el="hSum">
            All time
          </span>
          <span className="grid-hcap">Pieces you found each day</span>
        </div>
        <p className="grid-note" data-el="hMiss" hidden>
          Dates only apply to pieces you&rsquo;ve found.
        </p>
        <p className="grid-note" data-el="hNone" hidden>
          Pieces you find will show up here, day by day.
        </p>
        <div className="grid-hist" data-el="hist">
          <canvas data-el="histCv" aria-hidden="true" />
          <label className="grid-sr">
            From <input type="range" data-el="hFrom" min="0" max="1" step="1" defaultValue="0" />
          </label>
          <label className="grid-sr">
            To <input type="range" data-el="hTo" min="0" max="1" step="1" defaultValue="1" />
          </label>
        </div>
        <div className="grid-wbot" data-el="wbot">
          <button type="button" className="grid-tl" data-act="hist-play" aria-label="Replay your collection over time">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M7 4.5v15l13-7.5z" />
            </svg>
          </button>
          <div className="grid-seg grid-seg--xs" data-el="fPreset">
            <button type="button" data-p="7" aria-pressed="false">
              7 days
            </button>
            <button type="button" data-p="30" aria-pressed="false">
              30 days
            </button>
            <button type="button" data-p="0" aria-pressed="true">
              All
            </button>
          </div>
        </div>
        <div className="grid-prow">
          <button type="button" className="ui-primary" data-el="fFit">
            Show
          </button>
          <button type="button" className="ui-ghost" data-act="filter-clear">
            Clear
          </button>
        </div>
      </section>
      <section className="grid-zcard" data-el="zcard" aria-label="Start your collection">
        <b>Your collection starts with a game</b>
        <span>Finish a game in the Polkadot app and you might find new pieces. Some are rare.</span>
        <div className="grid-prow">
          <button type="button" className="ui-ghost ui-ghost--wide" data-act="look">
            Look around
          </button>
        </div>
      </section>
      <div className="grid-hint-card" data-el="hintCard" role="status">
        <b>Tap a piece to see it up close</b>
        <span>Gray dots are pieces you haven&rsquo;t found yet. Press and hold to look closer.</span>
      </div>
      <div className="grid-toast" data-el="toast" role="status" aria-live="polite" />
    </div>
  );
}

export default memo(GridScreen);
