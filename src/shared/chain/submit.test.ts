// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it, vi } from 'vitest';

import type { ChainSigner } from './signer';
import { type SubmitStatus, watchSubmission } from './submit';

const signer = {} as ChainSigner;

/** A fake papi tx that emits a fixed event stream (async, like the real one),
 *  and optionally errors the observer. Records the signer/options it's given. */
function fakeTx(events: unknown[], errorWith?: unknown) {
  const calls: { options: unknown }[] = [];
  let unsubscribed = false;
  const tx = {
    createSubmitAndWatch(_signer: ChainSigner, options?: unknown) {
      calls.push({ options });
      return {
        subscribe(observer: { next: (e: unknown) => void; error: (e: unknown) => void }) {
          queueMicrotask(() => {
            for (const e of events) observer.next(e);
            if (errorWith !== undefined) observer.error(errorWith);
          });
          return {
            unsubscribe: () => {
              unsubscribed = true;
            },
          };
        },
      };
    },
  };
  return { tx, calls, wasUnsubscribed: () => unsubscribed };
}

const inBlock = (ok: boolean, dispatchError?: unknown) => ({
  type: 'inBestBlock',
  ok,
  dispatchError,
});

describe('watchSubmission', () => {
  it('resolves ok on an in-block success and reports signing → inBlock', async () => {
    const status: SubmitStatus[] = [];
    const { tx, wasUnsubscribed } = fakeTx([inBlock(true)]);
    const result = await watchSubmission(tx, signer, (s) => status.push(s));
    expect(result).toEqual({ ok: true });
    expect(status).toEqual(['signing', 'inBlock']);
    expect(wasUnsubscribed()).toBe(true);
  });

  it('names the transaction and its block on the status calls and in the result', async () => {
    const block = { hash: '0xbb', number: 7, index: 1 };
    const { tx } = fakeTx([
      { type: 'created', txHash: '0xaa' },
      { type: 'broadcasted', txHash: '0xaa' },
      { type: 'inBestBlock', txHash: '0xaa', ok: true, block },
    ]);
    const seen: unknown[] = [];
    const result = await watchSubmission(tx, signer, (s, facts) => seen.push([s, { ...facts }]));
    expect(result).toEqual({ ok: true, tx: '0xaa', block: 7, blockHash: '0xbb' });
    expect(seen).toEqual([
      ['signing', {}],
      ['signed', { tx: '0xaa' }],
      ['broadcast', { tx: '0xaa' }],
      ['inBlock', { tx: '0xaa', block: 7, blockHash: '0xbb' }],
    ]);
  });

  it('keeps the hash on a failure after broadcast', async () => {
    const { tx } = fakeTx([{ type: 'broadcasted', txHash: '0xaa' }], new Error('socket died'));
    const result = await watchSubmission(tx, signer, () => {});
    expect(result).toMatchObject({ ok: false, tx: '0xaa', failure: { kind: 'transient' } });
    expect(result.block).toBeUndefined();
  });

  it('settles at the in-block event, not at finality', async () => {
    vi.useFakeTimers();
    try {
      const status: SubmitStatus[] = [];
      const { tx } = fakeTx([
        { type: 'broadcasted', txHash: '0xaa' },
        { type: 'notInBestBlock', txHash: '0xaa' },
      ]);
      const p = watchSubmission(tx, signer, (s) => status.push(s));
      await vi.advanceTimersByTimeAsync(0);
      // Nothing terminal yet: a block the tx left is no outcome.
      expect(status).toEqual(['signing', 'broadcast']);
      await vi.advanceTimersByTimeAsync(75_000);
      expect((await p).failure?.kind).toBe('transient');
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves with a classified failure on an in-block dispatch failure', async () => {
    const { tx } = fakeTx([
      inBlock(false, {
        type: 'Module',
        value: { type: 'Scarcity', value: { type: 'AddressOccupied' } },
      }),
    ]);
    const result = await watchSubmission(tx, signer, () => {});
    expect(result).toEqual({
      ok: false,
      error: 'Module · Scarcity · AddressOccupied',
      failure: { kind: 'transient', detail: 'Module · Scarcity · AddressOccupied' },
    });
  });

  it('settles as a failure when the stream errors inside subscribe()', async () => {
    let unsubscribed = false;
    const tx = {
      createSubmitAndWatch() {
        return {
          subscribe(observer: { next: (e: unknown) => void; error: (e: unknown) => void }) {
            observer.error(new Error('Incompatible runtime entry Tx(NftClaims.claim)'));
            return {
              unsubscribe: () => {
                unsubscribed = true;
              },
            };
          },
        };
      },
    };
    const result = await watchSubmission(tx, signer, () => {});
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Incompatible runtime entry Tx(NftClaims.claim)');
    expect(unsubscribed).toBe(true);
  });

  it('resolves failure (never rejects) when the observer errors', async () => {
    const { tx } = fakeTx([], new Error('socket died'));
    const result = await watchSubmission(tx, signer, () => {});
    expect(result).toEqual({
      ok: false,
      error: 'socket died',
      failure: { kind: 'transient', detail: 'socket died' },
    });
  });

  it('settles as a failure, with the hash, when the tx is dropped after broadcast', async () => {
    const dropped = Object.assign(new Error('Invalid Transaction: Stale'), { name: 'InvalidTxError' });
    const { tx } = fakeTx([{ type: 'broadcasted', txHash: '0xaa' }], dropped);
    const result = await watchSubmission(tx, signer, () => {});
    expect(result.ok).toBe(false);
    expect(result.tx).toBe('0xaa');
    expect(result.failure).toBeDefined();
  });

  it('settles transient (never hangs) when no terminal event ever arrives', async () => {
    vi.useFakeTimers();
    try {
      const { tx } = fakeTx([]); // nothing terminal
      const p = watchSubmission(tx, signer, () => {});
      await vi.advanceTimersByTimeAsync(75_000);
      const result = await p;
      expect(result.ok).toBe(false);
      expect(result.failure?.kind).toBe('transient');
    } finally {
      vi.useRealTimers();
    }
  });

  it('forwards papi options (e.g. the nonce) to createSubmitAndWatch', async () => {
    const { tx, calls } = fakeTx([inBlock(true)]);
    const options = { nonce: 7 };
    await watchSubmission(tx, signer, () => {}, options);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.options).toBe(options);
  });

  it('settles exactly once even if further events arrive', async () => {
    const onStatus = vi.fn();
    const { tx } = fakeTx([inBlock(true), { type: 'finalized', ok: true }]);
    const result = await watchSubmission(tx, signer, onStatus);
    expect(result).toEqual({ ok: true });
    // 'inBlock' reported once: the later finalized event doesn't re-report
    expect(onStatus.mock.calls.filter(([s]) => s === 'inBlock')).toHaveLength(1);
  });
});
