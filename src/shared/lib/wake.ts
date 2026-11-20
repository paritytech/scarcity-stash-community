// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// A wake-up at a given moment that holds up through a sleeping page: a timer
// fires once the moment has passed, and a page coming back into view wakes at
// once, since a hidden page's timers can stop. New uses it to let go of what
// turned 12 hours old (App.tsx).

/** How far past the moment the timer fires, so the moment has surely passed. */
const SLACK_MS = 1_000;

/** Now, in Unix seconds. */
export const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/** Calls `wake` once `at`, Unix seconds, has passed, and whenever the page
 *  comes back into view; with no `at`, only the latter. Returns the stop. */
export function wakeAt(at: number | undefined, wake: () => void): () => void {
  const timer = at === undefined ? undefined : setTimeout(wake, Math.max(0, at * 1000 - Date.now()) + SLACK_MS);
  const onVisible = (): void => {
    if (document.visibilityState === 'visible') wake();
  };
  document.addEventListener('visibilitychange', onVisible);
  return () => {
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', onVisible);
  };
}
