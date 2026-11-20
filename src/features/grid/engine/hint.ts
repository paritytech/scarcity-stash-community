// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// The idle hint: after 4 s with no input, one line on what the field is. A
// touch while it shows, or opening a piece, puts it away for the session.

import { arrivalBusy } from './arrival';
import { els, F, on } from './core';
import { detailOpen } from './detail';
import { fActive } from './filters';
import { layerOpen } from './history';
import { lensState } from './lens';
import { zeroInput } from './zero';

let lastInput = 0;
let hintT = 0;
let hintDone = false;
let hintFrom = 0;

export const lastInputAt = (): number => lastInput;

function markInput(): void {
  lastInput = performance.now();
  if (els.hintCard.classList.contains('is-show')) hideHint(true);
  zeroInput();
}

export function scheduleHint(): void {
  window.clearTimeout(hintT);
  if (hintDone || !F.foundCount) return;
  hintFrom = hintFrom || performance.now();
  const idle = (): number => performance.now() - Math.max(lastInput, hintFrom);
  hintT = window.setTimeout(
    () => {
      if (idle() < 3900 || arrivalBusy() || detailOpen() || lensState.on || layerOpen() || fActive()) {
        scheduleHint();
        return;
      }
      hintFrom = 0;
      els.hintCard.classList.add('is-show');
    },
    Math.max(400, 4000 - idle()),
  );
}

export function hideHint(done = false): void {
  window.clearTimeout(hintT);
  els.hintCard.classList.remove('is-show');
  if (done) hintDone = true;
}

export function attachHint(): void {
  on(window, 'pointerdown', markInput, { capture: true });
  on(window, 'keydown', markInput, { capture: true });
  on(window, 'wheel', markInput, { capture: true, passive: true });
}
