// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// What a link asks the app to open, read once from the page's query. A host
// keeps a product link's query when it opens the product, so another product
// or a notification can send the player straight to a screen: `?open=new`
// opens the grid on New. The target is taken out of the URL as it is read, so
// a reload of the page opens plain.

/** A screen a link names. */
export interface OpenTarget {
  open: 'new';
}

const OPEN = 'open';

/** The target `search` names, or null when it names none or one unknown. */
export function parseTarget(search: string): OpenTarget | null {
  const open = new URLSearchParams(search).get(OPEN);
  return open === 'new' ? { open } : null;
}

/** `search` without the target, with its leading `?` while anything is left. */
export function stripTarget(search: string): string {
  const params = new URLSearchParams(search);
  params.delete(OPEN);
  const rest = params.toString();
  return rest ? `?${rest}` : '';
}

/** The part of the page's location the target lives in, and the history that
 *  rewrites it; the app passes `window`'s, tests pass their own. */
interface PageLocation {
  pathname: string;
  search: string;
  hash: string;
}

interface PageHistory {
  state: unknown;
  replaceState: (state: unknown, unused: string, url: string) => void;
}

/** Read the target once, and leave the URL without it. */
export function consumeTarget(location: PageLocation, history: PageHistory): OpenTarget | null {
  const target = parseTarget(location.search);
  if (!target) return null;
  history.replaceState(history.state, '', `${location.pathname}${stripTarget(location.search)}${location.hash}`);
  return target;
}
