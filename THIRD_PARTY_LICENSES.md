# Third-party licences

Scarcity Stash bundles the following third-party packages in its production build. This file lists
each bundled package with its licence and source. Generated from the packages whose code is in
`dist/index.html`, read from the build sourcemap (`npx vite build --sourcemap`, then the
`node_modules/` entries of the emitted `.map`), with each licence read from the package's own
`package.json`. Regenerate it when dependencies change.

The production dependency tree is larger than this list; the rest is tree-shaken out and never
reaches the shipped file. `smoldot`, which carries GPL-3.0-or-later WITH Classpath-exception-2.0, is
pulled in by `polkadot-api`, and none of its code is in the build. A change that imports the light
client bundles it, and then it belongs in this list.

A build with telemetry on (`VITE_TELEMETRY=sentry` with `VITE_SENTRY_DSN` set) bundles seven more
packages. They are listed last.

The project itself is licensed under [GPL-3.0-only](./LICENSE). The licences below are those of the
bundled dependencies.

## Apache-2.0

The following packages are distributed under the Apache Licence 2.0. Each package's full licence
text ships in its own directory under `node_modules/<package>/`. Apache-2.0 requires that any
`NOTICE` file shipped by a package be carried through to redistributions. None of these packages
ships one.

- @parity/product-sdk-address@0.3.1: https://github.com/paritytech/product-sdk
- @parity/product-sdk-chain-client@0.13.11: https://github.com/paritytech/product-sdk
- @parity/product-sdk-host@0.35.0: https://github.com/paritytech/product-sdk
- @parity/product-sdk-logger@0.1.2: https://github.com/paritytech/product-sdk
- @parity/product-sdk-nfts@0.5.0: https://github.com/paritytech/product-sdk
- @parity/product-sdk-utils@0.2.1: https://github.com/paritytech/product-sdk
- @parity/result@0.2.0: https://github.com/paritytech/product-sdk
- rxjs@7.8.2: https://github.com/reactivex/rxjs

## MIT

The following packages are distributed under the MIT licence. Each package's full licence text and
copyright notice ship in its own directory under `node_modules/<package>/`, except `scale-ts`,
whose package states MIT in its `package.json` and ships no licence file.

- @noble/hashes@2.4.0: https://github.com/paulmillr/noble-hashes
- @parity/truapi@0.32.0: https://github.com/paritytech/trinity-user-agents
- @polkadot-api/json-rpc-provider@0.2.0: https://github.com/polkadot-api/polkadot-api
- @polkadot-api/metadata-builders@0.15.2: https://github.com/polkadot-api/polkadot-api
- @polkadot-api/metadata-compatibility@0.7.2: https://github.com/polkadot-api/polkadot-api
- @polkadot-api/observable-client@0.19.4: https://github.com/polkadot-api/polkadot-api
- @polkadot-api/raw-client@0.3.0: https://github.com/polkadot-api/polkadot-api
- @polkadot-api/raw-tx-creator@0.5.0: https://github.com/polkadot-api/polkadot-api
- @polkadot-api/signers-common@0.4.0: https://github.com/polkadot-api/polkadot-api
- @polkadot-api/substrate-bindings@0.21.2: https://github.com/polkadot-api/polkadot-api
- @polkadot-api/substrate-client@0.7.0: https://github.com/polkadot-api/polkadot-api
- @polkadot-api/utils@0.4.0: https://github.com/polkadot-api/polkadot-api
- @rx-state/core@0.1.4: https://github.com/rx-state/core
- @scure/base@2.4.0: https://github.com/paulmillr/scure-base
- @tanstack/query-core@5.107.1: https://github.com/TanStack/query
- neverthrow@8.2.0: https://github.com/supermacro/neverthrow
- polkadot-api@3.3.0: https://github.com/polkadot-api/polkadot-api
- react-dom@19.3.0: https://github.com/react/react
- react@19.3.0: https://github.com/react/react
- scale-ts@1.6.1: https://github.com/unstoppablejs/unstoppablejs
- scheduler@0.28.0: https://github.com/react/react
- zustand@5.0.15: https://github.com/pmndrs/zustand

## 0BSD

- tslib@2.8.1: https://github.com/Microsoft/tslib

## With telemetry on

A build with telemetry on also bundles these packages, each under the licence in brackets. Each
ships its licence text in its own directory, and none ships a `NOTICE` file.

- @sentry/browser-utils@11.8.0 (MIT): https://github.com/getsentry/sentry-javascript
- @sentry/browser@11.8.0 (MIT): https://github.com/getsentry/sentry-javascript
- @sentry/conventions@0.27.0 (MIT): https://github.com/getsentry/sentry-conventions
- @sentry/core@11.8.0 (MIT): https://github.com/getsentry/sentry-javascript
- @sentry/react@11.8.0 (MIT): https://github.com/getsentry/sentry-javascript
- @sentry/replay@11.8.0 (MIT): https://github.com/getsentry/sentry-javascript
- web-vitals@6.2.3 (Apache-2.0): https://github.com/GoogleChrome/web-vitals

---

### MIT licence text

```
Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial
portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

The copyright holders for each MIT package are named in that package's own licence file under
`node_modules/<package>/`.

### Apache-2.0 licence text

Not reproduced here. The full text is at https://www.apache.org/licenses/LICENSE-2.0 and ships in
each Apache-2.0 package's own directory under `node_modules/<package>/`.

### 0BSD licence text

Not reproduced here. `tslib` ships its own copy under `node_modules/tslib/`. 0BSD imposes no
attribution requirement; it is listed for completeness.
