// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

// The generated @polkadot-api/descriptors package lazy-imports each
// chain's FULL metadata (~1.5 MB total) for getOfflineApi/getTypedCodecs,
// which this app never calls; getTypedApi needs only the checksum and
// type-shape chunks. Harmless as never-fetched lazy chunks, but the
// singlefile build inlines every dynamic import, so stub them out.
// Anything that does call descriptors.getMetadata() then fails loudly.
// The regex is coupled to papi's generated chunk naming, so the build
// FAILS if nothing matched. Otherwise a papi rename would silently
// re-inline the metadata and balloon the bundle right back to ~2.4 MB.
const stubPapiDescriptorMetadata = () => {
  let stubbed = 0;
  return {
    name: 'stub-papi-descriptor-metadata',
    apply: 'build',
    enforce: 'pre',
    load(id) {
      if (/descriptors[/\\]dist[/\\]\w+_metadata-[\w-]+\.js$/.test(id)) {
        stubbed++;
        return 'export default ""';
      }
    },
    buildEnd() {
      if (stubbed === 0) {
        throw new Error(
          'stub-papi-descriptor-metadata matched no modules: papi likely renamed its metadata chunks; update the regex or the bundle regrows by ~1.5 MB',
        );
      }
    },
  };
};

// Telemetry is compiled in only when the build asks for it (VITE_TELEMETRY=sentry),
// and this proves a build without it carries no Sentry code: the build fails if
// any @sentry module rendered into a chunk. The DSN is a deploy variable that
// reaches the page as import.meta.env.VITE_SENTRY_DSN; without one the sink
// stays off even in a build that has it.
const sentryOn = process.env.VITE_TELEMETRY === 'sentry';
const keepSentryOut = () => ({
  name: 'keep-sentry-out',
  apply: 'build',
  renderChunk(_code, chunk) {
    if (sentryOn) return null;
    const leaked = Object.entries(chunk.modules ?? {})
      .filter(([id, m]) => /node_modules[/\\]@sentry[/\\]/.test(id) && m.renderedLength > 0)
      .map(([id]) => id);
    if (leaked.length > 0) throw new Error(`Sentry reached a build without VITE_TELEMETRY=sentry: ${leaked[0]}`);
    return null;
  },
});

export default defineConfig({
  define: {
    __TELEMETRY_SENTRY__: JSON.stringify(sentryOn),
    __STASH_COMMIT__: JSON.stringify(process.env.VITE_BUILD_COMMIT ?? 'dev'),
  },
  plugins: [react(), viteSingleFile(), stubPapiDescriptorMetadata(), keepSentryOut()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    host: true,
    port: 5174,
  },
});
