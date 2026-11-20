// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// The back button: while any layer is open there is one history entry, and
// back closes the top layer in the same order as Escape. A closing detail still counts as open, so a back press during its exit is
// absorbed instead of leaving the page.

import { flags, on } from './core';
import { closeDetail, detailOpen, DT } from './detail';
import { lensState } from './lens';
import { closeLoupe } from './lens';
import { closeSearch, searchOpen } from './search';
import { closeSheets, sheetOpen } from './sheets';

export const layerOpen = (): boolean => {
  // Before the grid is up there are no layers to ask about.
  if (!flags.attached) return false;
  return detailOpen() || searchOpen() || sheetOpen() || (lensState.sticky && !lensState.auto);
};

export function closeTop(): void {
  // A piece flying home (to search, too, which reopens under it) takes the
  // press: a second quick back must not close what it returns to.
  if (DT.closing) return;
  else if (searchOpen()) closeSearch();
  else if (detailOpen()) closeDetail();
  else if (sheetOpen()) closeSheets();
  else closeLoupe();
}

let armed = false;
let queued = false;

export function syncHistory(): void {
  if (queued) return;
  queued = true;
  void Promise.resolve().then(() => {
    queued = false;
    const open = layerOpen();
    if (open && !armed) {
      history.pushState({ gridLayer: 1 }, '');
      armed = true;
    } else if (!open && armed) {
      armed = false;
      history.back();
    }
  });
}

export function attachHistory(): void {
  on(window, 'popstate', () => {
    if (!armed) return;
    armed = false;
    closeTop();
    syncHistory();
  });
}

/** On detach, give back the entry this page pushed. */
export function releaseHistory(): void {
  if (armed) {
    armed = false;
    history.back();
  }
}
