// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

import { fileURLToPath, URL } from 'node:url';

import { defineConfig } from 'vitest/config';

// Standalone from vite.config.js: the app build's single-file and descriptor-stub
// plugins have no place in unit tests. Tests inject fake chains and stub the
// browser globals they need, so a node environment suffices.
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Clears call history between tests; implementations stay, so hoisted module
    // mocks keep their setup.
    clearMocks: true,
  },
});
