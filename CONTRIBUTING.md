# Contributing

This repository is a reference implementation and a proof of concept (see the warning at the top of
the [README](README.md)). It is not audited. The most useful contributions are bug reports that can
be reproduced and fixes that keep to the existing design.

## Issues

Search the open and closed issues first. A bug report needs the commit you built from, the host and
network you ran it on, the steps, what you expected, what happened, and any console output.

Do not open a public issue for a suspected vulnerability; see [Security](#security).

## Pull requests

Open an issue first for a change in behaviour or in what the app writes on chain. A typo or a
broken link can go straight to a pull request.

```bash
nvm use
npm ci
npm run check
npm run build
```

`npm run check` runs the type check, ESLint, Stylelint, the Prettier check, knip and the tests. CI
runs it and the build on every pull request.

- Commit messages and pull request titles follow
  [Conventional Commits](https://www.conventionalcommits.org) with a scope, for example
  `fix(grid): …`.
- Every TypeScript, JavaScript and CSS file starts with the copyright and licence header the others
  carry.
- A change to the dependencies updates `THIRD_PARTY_LICENSES.md` in the same pull request.
- A change to a flow updates the README section that describes it in the same pull request.
- No seeds, keys or tokens in the tree. Tests use the public addresses of the well-known
  development accounts (`src/testing/fixtures.ts`).
- The paritytech organisation runs a CLA check on every pull request. A `Co-Authored-By:` trailer
  in a commit message fails it.

## Licensing

This project is licensed under GPL-3.0-only. By opening a pull request you agree that your
contribution is licensed under the same terms.

## Security

For a suspected vulnerability, follow
[Parity's security policy](https://github.com/paritytech/.github/blob/main/SECURITY.md). Parity's
disclosure process and bug bounty are at <https://parity.io/bug-bounty>. The
[Security section of the README](README.md#security) describes what this code is and is not.

## Code of conduct

Participation is covered by the [Code of Conduct](CODE_OF_CONDUCT.md).
