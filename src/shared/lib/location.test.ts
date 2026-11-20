// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';

import { consumeTarget, parseTarget, stripTarget } from './location';

describe('a link that names what to open', () => {
  it('names New', () => {
    expect(parseTarget('?open=new')).toEqual({ open: 'new' });
    expect(parseTarget('?card=collectibles&open=new')).toEqual({ open: 'new' });
    expect(parseTarget('?frame=1&open=new')).toEqual({ open: 'new' });
  });

  it('names nothing when the target is missing or unknown', () => {
    expect(parseTarget('')).toBeNull();
    expect(parseTarget('?frame=1')).toBeNull();
    expect(parseTarget('?open=')).toBeNull();
    expect(parseTarget('?open=item')).toBeNull();
    expect(parseTarget('?open=New')).toBeNull();
  });

  it('leaves the rest of the query as it was', () => {
    expect(stripTarget('?open=new')).toBe('');
    expect(stripTarget('?open=new&frame=1')).toBe('?frame=1');
    expect(stripTarget('?frame=1&open=new')).toBe('?frame=1');
    expect(stripTarget('?frame=1')).toBe('?frame=1');
  });

  it('is read once and taken out of the URL', () => {
    const calls: [unknown, string][] = [];
    const history = {
      state: { gridLayer: 1 },
      replaceState: (state: unknown, _unused: string, url: string) => calls.push([state, url]),
    };
    const target = consumeTarget({ pathname: '/', search: '?open=new&frame=1', hash: '#top' }, history);
    expect(target).toEqual({ open: 'new' });
    expect(calls).toEqual([[{ gridLayer: 1 }, '/?frame=1#top']]);
  });

  it('touches the URL only when there is a target', () => {
    let replaced = 0;
    consumeTarget({ pathname: '/', search: '?frame=1', hash: '' }, { state: null, replaceState: () => replaced++ });
    expect(replaced).toBe(0);
  });
});
