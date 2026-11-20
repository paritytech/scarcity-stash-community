// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// The grid's haptics by kind, on the app's haptic engine: tick as the lens
// crosses a piece or a control steps, light when the lens rises or a piece
// lands, medium when a piece opens. Ticks stay quiet while the lens scrolls
// the grid, where they would buzz continuously.

import { haptic as engine } from '@/shared/ui/haptics';

export type HapticKind = 'tick' | 'light' | 'medium';

const EVENT = { tick: 'grid-tick', light: 'grid-light', medium: 'grid-medium' } as const;
let mute = false;
/** Browsers block vibration before the first touch, and warn each time. */
let acted = false;
window.addEventListener(
  'pointerdown',
  () => {
    acted = true;
  },
  { capture: true, once: true },
);

export function setTickMute(on: boolean): void {
  mute = on;
}

export function haptic(kind: HapticKind): void {
  if (!acted || (mute && kind === 'tick')) return;
  engine.play(EVENT[kind]);
}

/** Prime the vibration and iOS backends; call from a user gesture. */
export const primeHaptics = (): void => engine.initFromGesture();
