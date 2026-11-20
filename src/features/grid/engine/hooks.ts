// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// What the engine asks of the app around it: the writes it cannot do itself.

import type { OpenTarget } from '@/shared/lib/location';

export interface GridHooks {
  /** The grid is on screen, drawn from the last visit's saved state (`kept`) or
   *  from this session's reads, on the screen a link named (`target`), if any. */
  opened: (kept: boolean, target: OpenTarget['open'] | null) => void;
}

export const hooks: GridHooks = {
  opened: () => undefined,
};

export function setHooks(next: Partial<GridHooks>): void {
  Object.assign(hooks, next);
}
