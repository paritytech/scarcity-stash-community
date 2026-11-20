// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// Who the player is: this app's own product account 0, by its address, asked
// for until the host returns it. Outside a host there is none, and the app
// shows a notice to open it in the Polkadot app.

import { getAccountsProvider, type HostSubscription } from '@parity/product-sdk-host';

import { isInContainer, ownAccountAddress } from '@/shared/host/embed';
import { withDeadline } from '@/shared/lib/deadline';
import { createObservable } from '@/shared/lib/observable';

/** How long after an unanswered ask the next one goes out, by how many went
 *  unanswered: a session coming back to the web host takes tens of seconds. */
const ASK_AGAIN_MS: readonly number[] = [2_000, 5_000, 10_000, 20_000];
/** After the schedule above, how often the player is asked for. */
const ASK_STEADY_MS = 30_000;

const player = createObservable<string | null>(null);

/** The ask out now: the schedule and the host's connect share it. */
let asking: Promise<boolean> | null = null;

/** Ask the host for the player's own name. True once the player is named. */
function askForPlayer(): Promise<boolean> {
  asking ??= nameOwnPlayer().finally(() => {
    asking = null;
  });
  return asking;
}

async function nameOwnPlayer(): Promise<boolean> {
  if (player.get()) return true;
  try {
    const own = await withDeadline(ownAccountAddress(), 10_000, 'the app account');
    if (!own) return false;
    player.set(own);
    return true;
  } catch (err) {
    console.warn('[chain] own identity unavailable', err);
    return false;
  }
}

/** Names the player at boot. Resolves after the first ask; a host with no
 *  session yet is asked again until it names one. Never rejects. */
export async function initIdentity(): Promise<void> {
  if (!isInContainer) return;
  if (await askForPlayer()) return;
  void askUntilNamed();
}

async function askUntilNamed(): Promise<void> {
  const connection = await onAccountConnect(() => {
    // An ask already out may have gone before the session was back.
    void (asking ?? Promise.resolve()).then(askForPlayer);
  });
  for (let unanswered = 1; !player.get(); unanswered++) {
    const wait = ASK_AGAIN_MS[unanswered - 1] ?? ASK_STEADY_MS;
    await new Promise((resolve) => globalThis.setTimeout(resolve, wait));
    await askForPlayer();
  }
  connection?.unsubscribe();
}

/** Calls `connected` each time the host's account connects. Null from a host
 *  that does not report it. */
async function onAccountConnect(connected: () => void): Promise<HostSubscription | null> {
  try {
    const accounts = await getAccountsProvider();
    return (
      accounts?.subscribeAccountConnectionStatus((status) => {
        if (status === 'Connected') connected();
      }) ?? null
    );
  } catch (err) {
    console.warn('[chain] the host does not report when its account connects', err);
    return null;
  }
}

/** The player's address right now, null until the host has named the player. */
export const getPlayerAddress = (): string | null => player.get();

/** Calls `cb` with the player's address now and on every change. Returns an unsubscribe. */
export const subscribePlayer = (cb: (address: string | null) => void): (() => void) => player.subscribe(cb);

/** Whose records the reads and the screen write: '' until the player is known,
 *  which leaves the kept records as they are. Saved records carry this exact form. */
export function recordsOwner(): string {
  const address = player.get();
  return address ? `a:${address}|` : '';
}
