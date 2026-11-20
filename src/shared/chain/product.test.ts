// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';

import { deriveProductIdentifier } from './product';

describe('deriveProductIdentifier', () => {
  it.each(['localhost', '127.0.0.1', '10.0.2.2', '172.20.1.4', '192.168.1.5'])(
    'uses the product id in a dev server address on %s',
    (hostname) => {
      const page = { hostname, host: `${hostname}:5174`, search: '?product_id=stash.testnet' };
      expect(deriveProductIdentifier(page)).toBe('stash.testnet');
    },
  );

  it.each(['localhost', '127.0.0.1', '192.168.1.5'])(
    'uses localhost and the port for a dev server on %s without a product id',
    (hostname) => {
      expect(deriveProductIdentifier({ hostname, host: `${hostname}:5174` })).toBe('localhost:5174');
    },
  );

  it('uses localhost for a dev server without a port', () => {
    expect(deriveProductIdentifier({ hostname: '192.168.1.5', host: '192.168.1.5' })).toBe('localhost');
  });

  it('lowercases the product id of a dev server', () => {
    const page = { hostname: 'localhost', host: 'localhost:5174', search: '?product_id=Stash.Testnet' };
    expect(deriveProductIdentifier(page)).toBe('stash.testnet');
  });

  it('keeps the host and port of a *.localhost harness and ignores a product id there', () => {
    const page = { hostname: 'app.localhost', host: 'app.localhost:5173', search: '?product_id=stash.testnet' };
    expect(deriveProductIdentifier(page)).toBe('app.localhost:5173');
  });

  it.each(['stash.paseo', '8.8.8.8', '172.32.0.1'])('ignores a product id on %s', (hostname) => {
    expect(deriveProductIdentifier({ hostname, host: hostname, search: '?product_id=stash.testnet' })).toBe(hostname);
  });

  it('uses the registrable root of a bound DotNS hostname', () => {
    expect(
      deriveProductIdentifier({
        hostname: 'assets.stash.dot',
        host: 'assets.stash.dot',
      }),
    ).toBe('stash.dot');
  });

  it('maps gateway and app-preview hosts back to their DotNS binding', () => {
    expect(deriveProductIdentifier({ hostname: 'stash.paseo.li', host: 'stash.paseo.li' })).toBe('stash.paseo');
    expect(
      deriveProductIdentifier({
        hostname: 'stash.app.paseo.li',
        host: 'stash.app.paseo.li',
      }),
    ).toBe('stash.paseo');
    expect(deriveProductIdentifier({ hostname: 'stash.app.testnet.li', host: 'stash.app.testnet.li' })).toBe(
      'stash.testnet',
    );
    expect(deriveProductIdentifier({ hostname: 'stash.paseo', host: 'stash.paseo' })).toBe('stash.paseo');
  });
});
