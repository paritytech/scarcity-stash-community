// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';

import { asText, metadataValueHex, textOrHex, toHex } from './metadataBytes';

const bytes = (s: string) => new TextEncoder().encode(s);

describe('asText', () => {
  it('reads UTF-8 with tab, newline and return as text', () => {
    expect(asText(bytes('Greek\tCoffee\n'))).toBe('Greek\tCoffee\n');
    expect(asText(bytes('café ☕'))).toBe('café ☕');
  });

  it('rejects what the SDK rejects: other controls, DEL and C1, bidi controls, the replacement character', () => {
    expect(asText(bytes('a\u0000b'))).toBeNull();
    expect(asText(bytes('a\u007fb'))).toBeNull();
    expect(asText(bytes('a\u009fb'))).toBeNull();
    expect(asText(bytes('a\u202eb'))).toBeNull();
    expect(asText(bytes('a\u200fb'))).toBeNull();
    expect(asText(bytes('a\ufffdb'))).toBeNull();
  });

  it('rejects bytes that are not UTF-8', () => {
    expect(asText(new Uint8Array([0xff, 0xfe]))).toBeNull();
  });
});

describe('toHex and textOrHex', () => {
  it('renders bytes as lowercase 0x-hex, and text as itself', () => {
    expect(toHex(new Uint8Array([0, 0xab, 0xff]))).toBe('0x00abff');
    expect(textOrHex(new Uint8Array([0xff, 0xfe]))).toBe('0xfffe');
    expect(textOrHex(bytes('Sword'))).toBe('Sword');
  });
});

describe('metadataValueHex', () => {
  it("passes the SDK's rendering of bytes through", () => {
    expect(metadataValueHex('0x00abff')).toBe('0x00abff');
    expect(metadataValueHex('0x')).toBe('0x');
  });

  it('keys text by its own bytes, "0X" and uppercase hex text included', () => {
    expect(metadataValueHex('ab')).toBe('0x6162');
    expect(metadataValueHex('0xAB')).toBe('0x30784142');
    expect(metadataValueHex('0Xab')).toBe('0x30586162');
    expect(metadataValueHex('0xabc')).toBe('0x3078616263');
  });
});
