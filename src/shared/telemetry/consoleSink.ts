// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// One line per record on the console, the way a phone's log shows it: the
// hosts forward console lines to logcat and to the Xcode console, so this is
// the log that exists with no server at all.

import type { Sink, StepRecord } from './record';

const ms = (n: number): string => (n < 1000 ? `${String(n)}ms` : `${(n / 1000).toFixed(1)}s`);

/** A line `line` wrote: the journey and the request's last eight characters
 *  in brackets, the way no other console line opens. */
export const isRecordLine = (text: string): boolean => /^\[\w+ [^\s\]]{1,8}\] /.test(text);

/** The record as one line. */
export function line(r: StepRecord): string {
  const facts = Object.entries(r.facts)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(' ');
  const mark = r.outcome === 'ok' ? '' : ` ${r.outcome.toUpperCase()}`;
  return `[${r.journey} ${r.request.slice(-8)}] ${r.step}${mark} +${ms(r.sincePrev)}${facts ? ` ${facts}` : ''}`;
}

export const consoleSink: Sink = {
  record(r) {
    if (r.outcome === 'failed' || r.outcome === 'stalled') console.warn(line(r));
    else console.log(line(r));
  },
};
