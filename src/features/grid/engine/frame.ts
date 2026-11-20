// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// The frame loop. It runs only while something moves and stops itself when
// all is still; kick() starts it again. A task that throws is dropped and
// logged, and the loop always reschedules or resets, so kick() keeps working.

import { isBetweenSteps, settleBounds } from './camera';
import { F, flags, loop, tasks } from './core';
import { applyPieceTilt, DT } from './detail';
import { stepEdges } from './edges';
import { pointerActive } from './gestures';
import { lensState, placeLoupe, renderLens } from './lens';
import { INTRO_MS, render } from './render';
import { tilt } from './tilt';
import { zeroBusy } from './zero';

export function frame(now: number): void {
  let active = false;
  try {
    const dt = Math.max(0, Math.min(0.034, (now - loop.last) / 1000));
    loop.last = now;
    // A fling, and whatever runs at the grid's top or bottom.
    if (stepEdges(now, dt)) active = true;
    // Tasks run first, so anything their callbacks start (a lens, a focus
    // ring) is stepped and drawn in this same frame and keeps the loop alive.
    for (const t of tasks) {
      let keep = false;
      try {
        keep = t(now);
      } catch (err) {
        console.error(err);
      }
      if (!keep) tasks.delete(t);
      else active = true;
    }
    const tx = tilt.x.step(dt);
    const ty = tilt.y.step(dt);
    if (tx || ty) {
      active = true;
      flags.dirty = true;
      if (lensState.on) flags.lensDirty = true;
      applyPieceTilt();
    }
    if (F.intro === -2 && flags.booted) F.intro = now;
    if (F.intro >= 0) {
      if (now - F.intro > INTRO_MS) F.intro = -1;
      flags.dirty = true;
      active = true;
    }
    if (F.flash.size || F.burst.size || F.focusI >= 0 || zeroBusy()) {
      flags.dirty = true;
      active = true;
    }
    const L = lensState;
    const lm = Number(L.lx.step(dt)) | Number(L.ly.step(dt)) | Number(L.sc.step(dt));
    const fm = Number(L.fx.step(dt)) | Number(L.fy.step(dt));
    if (fm) flags.lensDirty = true;
    if (lm || fm) active = true;
    if (lm || L.on) placeLoupe();
    if (DT.rot.step(dt)) {
      active = true;
      applyPieceTilt();
    }
    // A grid at rest stands on a step: a zoom step that was cut short is finished here.
    if (!active && isBetweenSteps() && !pointerActive() && !L.on) {
      settleBounds();
      active = true;
    }
    if (flags.dirty && flags.booted) {
      render(now);
      flags.dirty = false;
    }
    if ((L.on || L.sc.x > 0.02) && flags.lensDirty) {
      renderLens();
      flags.lensDirty = false;
    }
  } catch (err) {
    console.error(err);
  }
  loop.raf = active && flags.attached ? requestAnimationFrame(frame) : 0;
}
