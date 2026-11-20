// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// One toast at a time above the dock, with an optional action button. A toast
// asked for while a piece is open waits for it to close, so it never covers
// the sheet's words.

import { els, flags } from './core';

let toastT = 0;
interface Action {
  label: string;
  fn: () => void;
}
let waiting: [string, Action | undefined] | null = null;

export function toast(msg: string, action?: Action): void {
  if (!flags.attached) return;
  if (els.app.classList.contains('is-detailing')) {
    waiting = [msg, action];
    return;
  }
  const el = els.toast;
  el.textContent = msg;
  el.classList.toggle('is-act', Boolean(action));
  if (action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'grid-toast-btn';
    b.textContent = action.label;
    b.addEventListener('click', () => {
      action.fn();
      el.classList.remove('is-show');
    });
    el.appendChild(b);
  }
  el.classList.add('is-show');
  window.clearTimeout(toastT);
  toastT = window.setTimeout(() => el.classList.remove('is-show'), action ? 6000 : 2400);
}

/** The piece closed: show the toast that waited for it. */
export function flushToast(): void {
  const w = waiting;
  waiting = null;
  if (w) toast(w[0], w[1]);
}
