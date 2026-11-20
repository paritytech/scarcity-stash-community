// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

import './styles.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { restoreCatalogues } from '@/entities/collections/catalogueStore';
import { collectionsStore } from '@/entities/collections/collectionsStore';
import { collectiblesStore } from '@/entities/nfts/collectibles';
import { initIdentity } from '@/entities/player/identity';
import { setOpenTarget } from '@/features/grid/engine';
import { startDueMints } from '@/features/holdings/mint';
import { startChainSync } from '@/features/holdings/sync';
import { isInContainer } from '@/shared/host/embed';
import { deviceStore } from '@/shared/lib/deviceStore';
import { consumeTarget } from '@/shared/lib/location';
import { openStep } from '@/shared/telemetry/open';
import { startTelemetry } from '@/shared/telemetry/start';
import ErrorBoundary from '@/shared/ui/ErrorBoundary';

import App, { HostNotice } from './App';

// Manrope and Inter, added here rather than in index.html: a stylesheet the
// page adds itself never blocks the first paint, so a slow connection shows
// the app in the system face and swaps when the fonts land.
const fonts = document.createElement('link');
fonts.rel = 'stylesheet';
fonts.href =
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Manrope:wght@500;600;700;800&display=swap';
document.head.appendChild(fonts);

function render(): void {
  const rootEl = document.getElementById('root');
  if (!rootEl) throw new Error('#root not found in index.html');
  createRoot(rootEl).render(
    <StrictMode>
      <ErrorBoundary>{isInContainer ? <App /> : <HostNotice />}</ErrorBoundary>
    </StrictMode>,
  );
}

// A link may name the screen to open on, such as New: read once, and taken
// out of the URL so a reload opens plain (lib/location.ts).
const target = consumeTarget(window.location, window.history);
if (target) setOpenTarget(target);

void (async () => {
  // The saved state is read from host storage first: the first frame draws the
  // holdings of the last open, and a chain read is never replaced by saved records.
  const readStarted = performance.now();
  await Promise.all([
    collectiblesStore.persist.rehydrate(),
    collectionsStore.persist.rehydrate(),
    deviceStore.persist.rehydrate(),
    restoreCatalogues(),
  ]);
  openStep('saved read', { ms: Math.round(performance.now() - readStarted) });
  render();
  // The Sentry sink, in a build that has it, once the first paint is done.
  startTelemetry();
  // Name the player first, so the first chain reads are for the right one.
  await initIdentity();
  startChainSync();
  startDueMints();
})();
