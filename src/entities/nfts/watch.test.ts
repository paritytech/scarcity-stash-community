// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type BlockRef, type BlockStream, watchBlocks } from './watch';

/** A block stream the test pushes by hand. */
function stream() {
  let push: ((block: BlockRef) => void) | null = null;
  const blocks: BlockStream = {
    subscribe: (observer) => {
      push = observer.next;
      return {
        unsubscribe: () => {
          push = null;
        },
      };
    },
  };
  return { blocks, emit: (n: number) => push?.({ hash: `0x${n}`, number: n }), subscribed: () => push !== null };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

describe('watchBlocks', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('signals each read that differs from the one before, once', async () => {
    const { blocks, emit } = stream();
    const values: Record<string, string> = { '0x1': 'a', '0x2': 'a', '0x3': 'b', '0x4': 'b' };
    const onChange = vi.fn();
    const watch = watchBlocks({ blocks, check: async (h) => values[h] ?? null, onChange, minIntervalMs: 0 });
    watch.rebase('a');
    for (const n of [1, 2, 3, 4]) {
      emit(n);
      await flush();
    }
    expect(onChange).toHaveBeenCalledTimes(1);
    watch.stop();
  });

  it('counts the first read as a change when it has nothing to compare it with', async () => {
    const { blocks, emit } = stream();
    const onChange = vi.fn();
    const watch = watchBlocks({ blocks, check: async () => 'a', onChange, minIntervalMs: 0 });
    emit(1);
    await flush();
    emit(2);
    await flush();
    expect(onChange).toHaveBeenCalledTimes(1);
    watch.stop();
  });

  it('checks at most once per interval, at the newest block seen', async () => {
    const { blocks, emit } = stream();
    const checked: string[] = [];
    const watch = watchBlocks({
      blocks,
      check: async (h) => {
        checked.push(h);
        return 'same';
      },
      onChange: () => {},
      minIntervalMs: 5_000,
    });
    emit(1);
    await flush();
    for (const n of [2, 3, 4, 5]) emit(n);
    await flush();
    expect(checked).toEqual(['0x1']);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(checked).toEqual(['0x1', '0x5']);
    watch.stop();
  });

  it('ignores a failed check and tries again on the next block', async () => {
    const { blocks, emit } = stream();
    let fail = true;
    const onChange = vi.fn();
    const watch = watchBlocks({
      blocks,
      check: async (h) => {
        if (h === '0x2' && fail) {
          fail = false;
          throw new Error('block not pinned');
        }
        return h === '0x1' ? 'a' : 'b';
      },
      onChange,
      minIntervalMs: 0,
    });
    watch.rebase('a');
    emit(1);
    await flush();
    emit(2);
    await flush();
    expect(onChange).not.toHaveBeenCalled();
    emit(3);
    await flush();
    expect(onChange).toHaveBeenCalledTimes(1);
    watch.stop();
  });

  it('drops a check that started before a rebase and compares with the rebased value', async () => {
    const { blocks, emit } = stream();
    let release!: () => void;
    const onChange = vi.fn();
    const watch = watchBlocks({
      blocks,
      check: (h) =>
        h === '0x2'
          ? new Promise((resolve) => {
              release = () => resolve('a');
            })
          : Promise.resolve(h === '0x1' ? 'a' : 'b'),
      onChange,
      minIntervalMs: 0,
    });
    watch.rebase('a');
    emit(1);
    await flush();
    emit(2);
    await flush();
    // The source's read lands while block 2 is being checked, and found 'b'.
    watch.rebase('b');
    release();
    await flush();
    emit(3);
    await flush();
    expect(onChange).not.toHaveBeenCalled();
    watch.stop();
  });

  it('counts the next read as a change after a rebase without a value', async () => {
    const { blocks, emit } = stream();
    const onChange = vi.fn();
    const watch = watchBlocks({ blocks, check: async () => 'a', onChange, minIntervalMs: 0 });
    watch.rebase('a');
    emit(1);
    await flush();
    expect(onChange).not.toHaveBeenCalled();
    // The watched keys changed: the same value may hide a change made before it.
    watch.rebase();
    emit(2);
    await flush();
    expect(onChange).toHaveBeenCalledTimes(1);
    watch.stop();
  });

  it('waits while nothing is watched', async () => {
    const { blocks, emit } = stream();
    let watched: string | null = null;
    const onChange = vi.fn();
    const watch = watchBlocks({ blocks, check: async () => watched, onChange, minIntervalMs: 0 });
    watch.rebase('x');
    emit(1);
    await flush();
    watched = 'x';
    emit(2);
    await flush();
    expect(onChange).not.toHaveBeenCalled();
    watched = 'y';
    emit(3);
    await flush();
    expect(onChange).toHaveBeenCalledTimes(1);
    watch.stop();
  });

  it('unsubscribes on stop', () => {
    const { blocks, subscribed } = stream();
    const watch = watchBlocks({ blocks, check: async () => 'a', onChange: () => {}, minIntervalMs: 0 });
    expect(subscribed()).toBe(true);
    watch.stop();
    expect(subscribed()).toBe(false);
  });
});
