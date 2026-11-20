// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// Focus for the layers over the grid. Opening one (a piece, a sheet, search)
// moves focus into it, Tab stays inside while it is open, and closing it gives
// focus back to whatever opened it. After a key press focus lands on the
// layer's first control, ringed; after a touch or a click it lands on the layer
// itself, which a screen reader names just the same, since a ring on a close
// button the player never reached for reads as a selection.

import { on } from './core';

interface Held {
  el: HTMLElement;
  back: HTMLElement | null;
}

const stack: Held[] = [];
/** Whether the player's last input was a key rather than a pointer. */
let keyboard = false;

const SELECTOR = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(SELECTOR)].filter(
    (e) =>
      !(e as HTMLButtonElement).disabled &&
      !e.closest('[hidden], [inert]') &&
      e.getClientRects().length > 0 &&
      getComputedStyle(e).visibility !== 'hidden',
  );
}

/** Moves focus into `el`: onto `first` after a key, onto `el` after a pointer.
 *  A text field takes focus either way. */
export function focusInto(el: HTMLElement, first?: HTMLElement | null): void {
  if (!stack.some((h) => h.el === el)) {
    const active = document.activeElement;
    stack.push({ el, back: active instanceof HTMLElement && active !== document.body ? active : null });
  }
  const control = first ?? focusables(el)[0];
  const target = control && (keyboard || control instanceof HTMLInputElement) ? control : el;
  if (target === el && !el.hasAttribute('tabindex')) el.tabIndex = -1;
  target.focus({ preventScroll: true });
}

/** `el` closed: give focus back to what opened it, or to `fallback`. */
export function focusBack(el: HTMLElement, fallback?: HTMLElement | null): void {
  const k = stack.findIndex((h) => h.el === el);
  if (k < 0) return;
  const [held] = stack.splice(k, 1);
  const back = held?.back;
  const usable = (e: HTMLElement | null | undefined): e is HTMLElement =>
    !!e && e.isConnected && !e.closest('[inert]') && getComputedStyle(e).visibility !== 'hidden';
  if (usable(back)) back.focus({ preventScroll: true });
  else if (usable(fallback)) fallback.focus({ preventScroll: true });
}

export function attachFocus(): void {
  stack.length = 0;
  keyboard = false;
  on(window, 'keydown', () => (keyboard = true), { capture: true });
  on(window, 'pointerdown', () => (keyboard = false), { capture: true });
  on(window, 'keydown', (e) => {
    if (e.key !== 'Tab') return;
    const top = stack[stack.length - 1];
    if (!top) return;
    const list = focusables(top.el);
    if (!list.length) return;
    const first = list[0]!;
    const last = list[list.length - 1]!;
    const at = document.activeElement;
    if (e.shiftKey && (at === first || at === top.el || !top.el.contains(at))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (at === last || !top.el.contains(at))) {
      e.preventDefault();
      first.focus();
    }
  });
}
