// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** The Sentry DSN, a deploy variable, never in the repo. */
  readonly VITE_SENTRY_DSN?: string;
}

/** Build constants (vite.config.js): whether the Sentry sink is compiled in,
 *  and the commit the build came from. */
declare const __TELEMETRY_SENTRY__: boolean;
declare const __STASH_COMMIT__: string;
