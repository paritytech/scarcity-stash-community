// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// A wake-up at a given moment: once the moment has passed, and whenever a
// page that slept comes back into view.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { nowSeconds, wakeAt } from './wake';

const page = Object.assign(new EventTarget(), { visibilityState: 'visible' });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 29, 12, 0));
  vi.stubGlobal('document', page);
  page.visibilityState = 'visible';
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('a wake-up', () => {
  it('wakes once the moment has passed, and not before', () => {
    const wake = vi.fn();
    wakeAt(nowSeconds() + 60, wake);
    vi.advanceTimersByTime(59_000);
    expect(wake).not.toHaveBeenCalled();
    vi.advanceTimersByTime(3_000);
    expect(wake).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(3_600_000);
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it('wakes when the page comes back after sleeping past the moment', () => {
    const wake = vi.fn();
    wakeAt(nowSeconds() + 60, wake);
    // Asleep: the clock ran on and the timer did not.
    vi.setSystemTime(new Date(2026, 9, 30, 8, 0));
    page.dispatchEvent(new Event('visibilitychange'));
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it('stays asleep while the page goes hidden, and with no moment set', () => {
    const wake = vi.fn();
    wakeAt(undefined, wake);
    page.visibilityState = 'hidden';
    page.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(86_400_000);
    expect(wake).not.toHaveBeenCalled();
  });

  it('wakes no more once stopped', () => {
    const wake = vi.fn();
    const stop = wakeAt(nowSeconds() + 60, wake);
    stop();
    vi.advanceTimersByTime(120_000);
    page.dispatchEvent(new Event('visibilitychange'));
    expect(wake).not.toHaveBeenCalled();
  });
});
