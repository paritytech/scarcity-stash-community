// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// The device's network as the webview reports it: the value now, and each
// change the online and offline events bring, reported once.

import { afterEach, describe, expect, it, vi } from 'vitest';

async function load(onLine: boolean) {
  const network = new EventTarget();
  const device = { onLine };
  vi.stubGlobal('window', network);
  vi.stubGlobal('navigator', device);
  vi.resetModules();
  return { online: await import('./online'), network, device };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the device network', () => {
  it('starts from what the webview reports', async () => {
    expect((await load(false)).online.onlineNow()).toBe(false);
    expect((await load(true)).online.onlineNow()).toBe(true);
  });

  it('follows the offline and online events, reporting each change once', async () => {
    const { online, network, device } = await load(true);
    const seen: boolean[] = [];
    online.subscribeOnline((now) => seen.push(now));
    device.onLine = false;
    network.dispatchEvent(new Event('offline'));
    network.dispatchEvent(new Event('offline'));
    device.onLine = true;
    network.dispatchEvent(new Event('online'));
    expect(seen).toEqual([true, false, true]);
    expect(online.onlineNow()).toBe(true);
  });
});
