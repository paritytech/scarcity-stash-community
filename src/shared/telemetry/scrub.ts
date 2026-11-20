// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// What must never leave the phone, even by accident: a recovery phrase, a
// secret key, a token in an address. Nothing in a record should carry
// any of them, and this is the guard for the day something does: an error
// from the host's connection, for one, quotes the socket address with the
// token the host gave it.

/** Twelve or more short lowercase words in a row read like a recovery phrase;
 *  prose breaks that with a comma, a capital or a long word. */
const PHRASE = /\b(?:[a-z]{3,8} ){11,}[a-z]{3,8}\b/g;
/** 128 hex digits or more is a secret key; a hash or an address is shorter. */
const SECRET_HEX = /0x[0-9a-fA-F]{128,}/g;
/** A socket address's query: where a host puts the token for its socket. */
const SOCKET_QUERY = /\b(wss?:\/\/[^\s?#"'<>()]*)\?[^\s#"'<>()]*/g;
/** A query parameter named like a credential, in any address. */
const TOKEN_PARAM =
  /([?&](?:t|token|access_token|id_token|refresh_token|auth|key|api_?key|secret|sig|signature|session|password|code)=)[^&\s#"'<>()]+/gi;

export function scrubText(s: string): string {
  return s
    .replace(SOCKET_QUERY, '$1?[query removed]')
    .replace(TOKEN_PARAM, '$1[removed]')
    .replace(SECRET_HEX, '[secret removed]')
    .replace(PHRASE, '[phrase removed]');
}

/** A copy of a plain value with every string scrubbed. */
export function scrubValue<T>(value: T): T {
  if (typeof value === 'string') return scrubText(value) as T;
  if (Array.isArray(value)) return value.map((v: unknown) => scrubValue(v)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = scrubValue(v);
    return out as T;
  }
  return value;
}
