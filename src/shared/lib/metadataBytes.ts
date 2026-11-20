// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// Metadata bytes as @parity/product-sdk-nfts reports them: text when they
// read as text, lowercase 0x-hex otherwise. The SDK does not export this rule,
// and the mint preview reads raw metadata_batch layers before anything is
// minted (credits/preview.ts), so the rule lives here too, matched to
// the SDK's: the preview and the grid must read the same bytes the same way,
// or the blurred preview and the minted NFT disagree about one item.

const UTF8 = new TextDecoder('utf-8', { fatal: true });
const HEX = '0123456789abcdef';

/** `bytes` as text, or null when they are not UTF-8 or hold a control, bidi or
 *  replacement character (tab, newline and return allowed). */
export function asText(bytes: Uint8Array): string | null {
  let decoded: string;
  try {
    decoded = UTF8.decode(bytes);
  } catch {
    return null;
  }
  for (const char of decoded) {
    const code = char.codePointAt(0)!;
    if (code === 0xfffd) return null;
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return null;
    if (code >= 0x7f && code <= 0x9f) return null;
    if (isBidiControl(code)) return null;
  }
  return decoded;
}

/** The bidi controls: the Arabic letter mark, the two marks, the embeddings
 *  and overrides, and the isolates. */
function isBidiControl(code: number): boolean {
  if (code === 0x061c || code === 0x200e || code === 0x200f) return true;
  return (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
}

/** `bytes` as lowercase 0x-hex: the SDK's rendering of bytes that are not text. */
export function toHex(bytes: Uint8Array): string {
  let hex = '0x';
  for (const byte of bytes) hex += HEX[byte >> 4]! + HEX[byte & 15]!;
  return hex;
}

/** `bytes` as the SDK reports a metadata value. */
export function textOrHex(bytes: Uint8Array): string {
  return asText(bytes) ?? toHex(bytes);
}

/** The 0x-hex of the bytes behind a metadata value. Text already in the SDK's
 *  hex form ("0xab", lowercase, whole bytes) is taken as those bytes. */
export function metadataValueHex(value: string): string {
  if (/^0x(?:[0-9a-f]{2})*$/.test(value)) return value;
  return toHex(new TextEncoder().encode(value));
}
