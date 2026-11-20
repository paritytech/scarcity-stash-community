// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// The grid is one picture to a screen reader and to Tab. This list is the way
// in for both: every piece you hold or have a credit for, newest find first, as a
// button, drawn nowhere. Tab lands on it once and the arrows move along it, as
// in any list; the piece in focus comes into view with the focus pulse, and
// Enter opens it.

import { shortDate } from '../model/days';
import { pieceSize } from '../model/grid';
import { framePiece, scrollTo, stopCam } from './camera';
import { cam, els, F, foundAt, isShown, kick, nameOf, on, placeOf, sx, sy } from './core';
import { DT, openDetail } from './detail';
import { showFocusName } from './filters';
import { clamp } from './util';

let built = '';

function label(i: number): string {
  const when = foundAt(i);
  const status = when ? `found ${shortDate(when)}` : '';
  return [nameOf(i), placeOf(i), status].filter(Boolean).join(', ');
}

/** Rebuild the list after the field changed; nothing happens when the same
 *  pieces are there in the same order, in the same state. */
export function buildPieceList(): void {
  const order: number[] = [];
  for (let i = 0; i < F.pieces.length; i++) if (isShown(i)) order.push(i);
  order.sort((a, b) => (F.pieces[b]!.foundAt ?? 0) - (F.pieces[a]!.foundAt ?? 0));
  const sig = order.map((i) => `${F.layout.cells[i]!.key}:${F.pieces[i]!.status}`).join(',');
  if (sig === built) return;
  built = sig;
  const list = els.pieceList;
  const had = list.contains(document.activeElement);
  const focusKey = had && document.activeElement instanceof HTMLElement ? document.activeElement.dataset.key : '';
  list.textContent = '';
  order.forEach((i, k) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.tabIndex = k === 0 ? 0 : -1;
    b.dataset.key = F.layout.cells[i]!.key;
    b.textContent = label(i);
    li.appendChild(b);
    list.appendChild(li);
  });
  if (!had) return;
  // The piece in focus keeps it through a rebuild, and its place in the list.
  const back = focusKey ? list.querySelector<HTMLElement>(`button[data-key="${CSS.escape(focusKey)}"]`) : null;
  if (back) {
    for (const b of list.querySelectorAll<HTMLButtonElement>('button')) b.tabIndex = b === back ? 0 : -1;
    back.focus({ preventScroll: true });
  } else list.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
}

const indexOf = (b: Element | null): number | undefined =>
  b instanceof HTMLElement && b.dataset.key ? F.layout.index.get(b.dataset.key) : undefined;

/** Bring piece i into view and mark it, as stepping does. */
function showPiece(i: number): void {
  scrollTo(framePiece(i), 0, (cut) => {
    if (cut) return;
    F.focusI = i;
    F.focusT = performance.now();
    kick();
  });
  showFocusName(i);
}

function openPiece(i: number): void {
  if (DT.open || DT.busy) return;
  stopCam();
  const { px, py } = F.layout;
  openDetail(i, { x: sx(px[i]!), y: sy(py[i]!), s: Math.max(pieceSize(cam.s), 12) });
}

export function attachPieceList(): void {
  built = '';
  const list = els.pieceList;
  on(list, 'focusin', (e) => {
    const i = indexOf(e.target as Element);
    if (i !== undefined && !DT.open) showPiece(i);
  });
  on(list, 'click', (e) => {
    const b = (e.target as Element).closest('button');
    const i = indexOf(b);
    if (i !== undefined) openPiece(i);
  });
  on(list, 'keydown', (e) => {
    const buttons = [...list.querySelectorAll<HTMLButtonElement>('button')];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    const to =
      e.key === 'ArrowDown' || e.key === 'ArrowRight'
        ? at + 1
        : e.key === 'ArrowUp' || e.key === 'ArrowLeft'
          ? at - 1
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? buttons.length - 1
              : null;
    if (to === null) return;
    e.preventDefault();
    const next = buttons[clamp(to, 0, buttons.length - 1)];
    if (!next) return;
    buttons[at]!.tabIndex = -1;
    next.tabIndex = 0;
    next.focus({ preventScroll: true });
  });
}
