// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// What a host shows for this product in its list of products: its name, its one-line description and its
// icon. The host reads these from the on-chain root manifest, never from the page's head, and it renders
// only PNG or JPEG.
//
// A plain object rather than `defineConfig`, so this file needs no import: bulletin-deploy is installed
// globally, not as a dependency of this repo, and an unresolvable import would break the load.
//
// bulletin-deploy stops when this domain differs from the <domain> argument it runs with, so the
// domain is derived rather than fixed: the label from DOTNS_LABEL (default `stash`) and the TLD from
// DOTNS_TLD (default `paseo`; `testnet` on Previewnet).
//
// Pass the domain as `<label>.<tld>`. With a bare label the content is uploaded but the manifest is
// not: "Config domain 'stash.paseo' does not match deploy domain 'stash'".
//
// Every run that reads this file writes the manifest; `--no-manifest` leaves it out.
const label = process.env.DOTNS_LABEL ?? 'stash';
const tld = process.env.DOTNS_TLD ?? 'paseo';

export default {
  domain: `${label}.${tld}`,
  displayName: 'Collectibles',
  description: 'Every collectible you earn lives here.',
  // Deliberately NOT under public/: vite copies that directory into dist, which would ship the icon
  // inside the deployed archive for nothing. The deploy uploads and references it on its own.
  icon: { path: './icon.png', format: 'png' as const },
  // Keep in step with the version in package.json.
  executables: [{ kind: 'app' as const, path: './dist', appVersion: [0, 1, 0] as const }],
};
