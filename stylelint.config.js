// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// Stylelint 17. The standard config catches mistakes and keeps modern CSS
// notation; the recess order keeps every declaration block in the same
// property order (position, box, type, paint), so a rule reads the same
// wherever it sits. Prettier handles the whitespace.
export default {
  extends: ['stylelint-config-standard', 'stylelint-config-recess-order'],
  ignoreFiles: ['dist/**', 'node_modules/**'],
  rules: {
    // The house naming: kebab-case blocks, `--modifier` variants and `is-state` flags.
    'selector-class-pattern': [
      '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:--[a-z0-9]+(?:-[a-z0-9]+)*)?$',
      {
        message: (selector) => `Expected class "${selector}" to be kebab-case, with an optional --modifier`,
      },
    ],
    // The stylesheet is ordered by component, not by specificity; the rule
    // would only ever ask for reorders that break that reading order.
    'no-descending-specificity': null,
    // The app runs inside iOS and Android WebViews and the build adds no
    // prefixes itself, so the `-webkit-` twin of these stays next to the
    // standard property for the WebViews that still need it.
    'property-no-vendor-prefix': [
      true,
      {
        ignoreProperties: [
          '-webkit-appearance',
          '-webkit-backdrop-filter',
          '-webkit-background-clip',
          '/^-webkit-mask/',
          '-webkit-user-select',
        ],
      },
    ],
    // Font stacks live in custom properties; their names keep their case.
    'value-keyword-case': ['lower', { ignoreProperties: ['/^--font-/'] }],
  },
};
