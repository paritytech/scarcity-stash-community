// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';

import { isLostBlock } from './lostBlock';

const named = (name: string, message: string) => Object.assign(new Error(message), { name });

describe('a read that only lost its block', () => {
  it('is one the chain library rejected for a block it let go of', () => {
    expect(isLostBlock(named('BlockNotPinnedError', 'Block 0xab is not pinned (storageQueries)'))).toBe(true);
    expect(isLostBlock(new Error('Block 0xab is not pinned (stop-call)'))).toBe(true);
  });

  it('is one whose follow ended, under the library name or the message alone', () => {
    expect(isLostBlock(named('DisjointError', 'ChainHead disjointed'))).toBe(true);
    expect(isLostBlock(named('StopError', 'ChainHead stopped'))).toBe(true);
    expect(isLostBlock('ChainHead disjointed')).toBe(true);
  });

  it('is one that fell back to an archive read the host does not serve', () => {
    const answer = {
      name: 'RpcError',
      message: 'Method "archive_v1_storage" is not supported by the host',
      code: -32601,
    };
    expect(isLostBlock(answer)).toBe(true);
  });

  it('is one the host returned for a follow it no longer knows', () => {
    const failure = new Error('HostFailure: remote_chain_head_storage: unknown follow subscription id "c16:host:1326"');
    expect(isLostBlock(failure)).toBe(true);
  });

  it('is found under the error that wraps it', () => {
    const cause = named('BlockNotPinnedError', 'Block 0xab is not pinned (storageQueries)');
    expect(isLostBlock(new Error('the NFT read failed', { cause }))).toBe(true);
  });

  it('is not a timeout, a dropped host connection, a full operation slot or nothing at all', () => {
    expect(isLostBlock(new Error('the credits read timed out after 30s'))).toBe(false);
    expect(isLostBlock(named('ConnectionResetError', 'TrUAPI host connection interrupted'))).toBe(false);
    expect(isLostBlock(named('OperationLimitError', 'ChainHead operations limit reached'))).toBe(false);
    expect(isLostBlock(undefined)).toBe(false);
    expect(isLostBlock(null)).toBe(false);
  });
});
