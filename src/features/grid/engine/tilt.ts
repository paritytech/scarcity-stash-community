// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// Tilt: on desktop the pieces lean toward the mouse. On a phone it stays off,
// so the grid holds still in the hand.

import { els, kick, on, view } from './core';
import { clamp, Spring } from './util';

export const tilt = { x: new Spring(0, 50, 11), y: new Spring(0, 50, 11) };

export function attachTilt(): void {
  on(els.app, 'pointermove', (e) => {
    if (e.pointerType !== 'mouse' || e.buttons) return;
    tilt.x.set(clamp(((e.clientX - view.left) / view.W - 0.5) * 1.3, -1, 1));
    tilt.y.set(clamp(((e.clientY - view.top) / view.H - 0.5) * 1.3, -1, 1));
    kick();
  });
}
