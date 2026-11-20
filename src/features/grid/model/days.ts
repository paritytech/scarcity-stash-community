// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// Calendar days for the grid's date filter and its chart. A day is a local
// calendar date, numbered so consecutive dates differ by one whatever the
// clocks did in between.

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** The local calendar day of a Unix-seconds time, as a day number. */
export function dayNumber(unixSeconds: number): number {
  const d = new Date(unixSeconds * 1000);
  return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000);
}

/** The local date a day number stands for. */
export function dateOfDay(day: number): Date {
  const u = new Date(day * 86_400_000);
  return new Date(u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate());
}

/** Today's day number. */
export const today = (now: number = Date.now()): number => dayNumber(now / 1000);

/** "Oct 3" */
export const shortDate = (d: Date): string => `${MON[d.getMonth()]!} ${d.getDate()}`;

/** "Oct 3, 2026" */
export const longDate = (d: Date): string => `${MON[d.getMonth()]!} ${d.getDate()}, ${d.getFullYear()}`;

/** "Fri, Oct 3" */
export const dayDate = (d: Date): string => `${DAY[d.getDay()]!}, ${MON[d.getMonth()]!} ${d.getDate()}`;

/** "Oct", for the chart's month ticks. */
export const monthName = (d: Date): string => MON[d.getMonth()]!;
