// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// Which gestures on the detail sheet move the sheet and which scroll its body
// (engine/detail.ts). The body asks the browser for pan-y alone (grid.css):
// WebKit, the engine of every iOS host, has no directional touch-action, so
// the pull back to peek is passed to the sheet by cancelling the moves the
// browser would otherwise scroll with.

/** What the sheet is doing when a gesture begins. */
export interface SheetState {
  expanded: boolean;
  /** Landscape: the sheet is a side panel with no peek to fall back to. */
  land: boolean;
}

/** Whether a first move of `dy` px (down positive) pulls the expanded sheet to
 *  peek rather than scrolling its body; iOS reports scrollTop below 0 in bounce. */
export const pullsSheet = (sheet: SheetState, scrollTop: number, dy: number): boolean =>
  sheet.expanded && !sheet.land && scrollTop <= 0 && dy > 0;

/** Whether a wheel turned over the sheet in peek opens it, as a drag up does:
 *  mostly vertical, toward more, and only when there is more to show. */
export const wheelOpens = (sheet: SheetState & { info: boolean }, deltaX: number, deltaY: number): boolean =>
  !sheet.expanded && !sheet.land && sheet.info && deltaY > 0 && Math.abs(deltaY) > Math.abs(deltaX);
