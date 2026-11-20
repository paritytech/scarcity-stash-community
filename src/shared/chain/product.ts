// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// The Product SDK account namespace must be the exact DotNS identifier the
// host bound this page under. The host's signing gate compares it strictly;
// hardcoding a different deployment name derives the wrong account.

/** The TLDs DotNS registers product names under, one per network. A host keeps
 *  the TLD in the product id (`stash.paseo`), so the app must ask under it. */
export const DOTNS_TLDS = ['dot', 'paseo', 'testnet'];

/** Loopback (127/8) and private (10/8, 172.16/12, 192.168/16) IPv4 addresses. */
const LOOPBACK_OR_PRIVATE_IPV4 = /^(127\.\d+|10\.\d+|172\.(1[6-9]|2\d|3[01])|192\.168)\.\d+\.\d+$/;

/** Whether a host's debug build opens a page from this address as a dev
 *  server: localhost, or a loopback or private IPv4 address. */
function isDevServerAddress(hostname: string): boolean {
  return hostname === 'localhost' || LOOPBACK_OR_PRIVATE_IPV4.test(hostname);
}

/** The product id a host runs this page under, from the page address: a DotNS
 *  name's root, a gateway name's `<name>.<tld>`, or a dev server's `?product_id=`. */
export function deriveProductIdentifier(input: { hostname: string; host: string; search?: string }): string {
  const hostname = input.hostname.toLowerCase();
  const host = input.host.toLowerCase();

  if (isDevServerAddress(hostname)) {
    const productId = new URLSearchParams(input.search ?? '').get('product_id');
    return productId ? productId.toLowerCase() : `localhost${host.slice(hostname.length)}`;
  }
  const segments = hostname.split('.');
  const tld = segments[segments.length - 1] ?? '';
  if (DOTNS_TLDS.includes(tld)) {
    return segments.length > 2 ? segments.slice(-2).join('.') : hostname;
  }

  // A gateway host: `<name>[.app].<tld>.li` serves the name `<name>.<tld>`.
  if (
    segments.length >= 3 &&
    segments[segments.length - 1] === 'li' &&
    DOTNS_TLDS.includes(segments[segments.length - 2] ?? '')
  ) {
    let labels = segments.slice(0, -2);
    if (labels[labels.length - 1] === 'app') labels = labels.slice(0, -1);
    if (labels.length > 0) return `${labels.join('.')}.${segments[segments.length - 2]}`;
  }

  return host;
}

/** The product id of this page. Outside a page, as in the tests, there is
 *  none, and it is ''. */
function getProductIdentifier(): string {
  if (typeof window === 'undefined') return '';
  return deriveProductIdentifier({
    hostname: window.location.hostname,
    host: window.location.host,
    search: window.location.search,
  });
}

/** Stable for the page lifetime: a navigation loads a fresh bundle. */
export const DOTNS_IDENTIFIER = getProductIdentifier();
