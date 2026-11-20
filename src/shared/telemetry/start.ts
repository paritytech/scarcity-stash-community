// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// Where the Sentry sink joins, and the only place. A build without
// VITE_TELEMETRY=sentry has no SDK at all (vite.config.js rejects a bundle
// that carries one); a build with it adds the sink after first paint, inside
// a host, with a DSN, once the host has granted the ingest domain, asked on
// every open and never stored. Outside a host nothing is ever sent.

import { requestPermission } from '@parity/product-sdk-host';

import { NETWORK } from '@/shared/chain/network';
import { DOTNS_IDENTIFIER } from '@/shared/chain/product';
import { isInContainer } from '@/shared/host/embed';
import { withDeadline } from '@/shared/lib/deadline';

import { addSink, flushTelemetry } from './log';

/** The host's sheet waits for a person; past this the sink stays off this open. */
const GRANT_DEADLINE_MS = 60_000;

/** ios, android, or host: which container runs the page, by its user agent. */
function hostKindOf(): string {
  if (typeof window === 'undefined') return 'none';
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) return 'ios';
  if (ua.includes('Android')) return 'android';
  return 'host';
}

/** Whether the host lets this page reach `domain`. A rejection, a stalled sheet
 *  or a host without the call all return false, and nothing is stored. */
async function remoteGranted(domain: string): Promise<boolean> {
  try {
    const result = await withDeadline(
      Promise.resolve().then(() => requestPermission({ tag: 'Remote', value: { domains: [domain] } })),
      GRANT_DEADLINE_MS,
      `network access to ${domain}`,
    );
    return result.ok && result.value;
  } catch (err) {
    console.warn(`[telemetry] no result for ${domain}`, err);
    return false;
  }
}

async function joinSentry(dsn: string): Promise<void> {
  let domain: string;
  try {
    domain = new URL(dsn).host;
  } catch {
    console.warn('[telemetry] off: the DSN is not a URL');
    return;
  }
  if (!(await remoteGranted(domain))) {
    console.log(`[telemetry] off: the host did not grant ${domain}`);
    return;
  }
  const { flushSentry, sentrySink } = await import('./sentry');
  addSink(
    sentrySink({ dsn, site: DOTNS_IDENTIFIER, release: __STASH_COMMIT__, hostKind: hostKindOf(), network: NETWORK }),
  );
  window.addEventListener('pagehide', () => {
    flushTelemetry();
    void flushSentry();
  });
  console.log(`[telemetry] on: ${DOTNS_IDENTIFIER} ${__STASH_COMMIT__}`);
}

/** Join the Sentry sink once the first paint is done. */
export function startTelemetry(): void {
  if (!__TELEMETRY_SENTRY__) return;
  const dsn = import.meta.env.VITE_SENTRY_DSN;
  if (!dsn) {
    console.log('[telemetry] off: no DSN in this build');
    return;
  }
  if (!isInContainer) {
    console.log('[telemetry] off: not inside a host');
    return;
  }
  const start = (): void => void joinSentry(dsn);
  if (typeof requestIdleCallback === 'function') requestIdleCallback(start, { timeout: 5_000 });
  else setTimeout(start, 1_000);
}
