// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-only

// ESLint 10 flat config.
//
// One typed pass over the app: TypeScript rules that read the types
// (typescript-eslint, strict and stylistic), React rules that know React 19
// and the React Compiler (react-hooks 7, eslint-react), Vite's fast-refresh
// rule, Vitest rules on the tests, and sorted imports. Formatting is
// Prettier's alone: eslint-config-prettier switches every formatting rule off.
//
// Every rule that leaves a preset's default is set below with its reason, so
// the config reads as the house decisions and nothing else. A rule that is
// right in general but wrong at one spot is handled in the code, with an
// `eslint-disable-next-line <rule> -- <reason>` comment, never here.
//
// Files outside src (the Vite, Vitest and deploy configs, this file) are
// linted without type information; they are not in tsconfig's project.
import js from '@eslint/js';
import eslintReact from '@eslint-react/eslint-plugin';
import vitest from '@vitest/eslint-plugin';
import eslintConfigPrettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

// An import of one of the top folders of src, by alias or by a relative path.
const importOf = (folders) => `^(@/|(\\.\\./)+)(${folders.join('|')})(/|$)`;
// An import of one of the entities from another entity, by alias or by a relative path.
const entityImportOf = (entities) => `^(@/entities/|\\.\\./)(${entities.join('|')})(/|$)`;

/** The entities in the one order they import each other: each imports only those before it. */
const ENTITIES = ['player', 'art', 'collections', 'nfts', 'credits'];

/** A layer may not import the layers above it, and an entity may not import
 *  the entities after it. */
const noImportsFrom = (above, laterEntities = []) => [
  'error',
  {
    patterns: [
      { regex: importOf(above), message: 'Imports go down the layers: app, features, entities, shared.' },
      ...(laterEntities.length > 0
        ? [{ regex: entityImportOf(laterEntities), message: `Entities import in one order: ${ENTITIES.join(', ')}.` }]
        : []),
    ],
  },
];

const LICENCE_HEADER = '// Copyright 2026 Parity Technologies (UK) Ltd.\n// SPDX-License-Identifier: GPL-3.0-only\n';

/** Fails a file that does not start with the licence header. */
const licenceHeader = {
  create: (context) => ({
    Program(node) {
      if (!context.sourceCode.text.startsWith(LICENCE_HEADER)) {
        context.report({ node, loc: { line: 1, column: 0 }, message: 'The file starts with the licence header.' });
      }
    },
  }),
};

export default defineConfig([
  globalIgnores(['dist/**', '.papi/descriptors/**', 'coverage/**', 'public/**']),

  // Every code file starts with the copyright and licence lines.
  {
    files: ['**/*.{ts,tsx,js}'],
    plugins: { stash: { rules: { 'licence-header': licenceHeader } } },
    rules: { 'stash/licence-header': 'error' },
  },

  // The app, with type information.
  {
    files: ['src/**/*.{ts,tsx}', '.papi/whitelist.ts'],
    extends: [
      js.configs.recommended,
      tseslint.configs.strictTypeChecked,
      tseslint.configs.stylisticTypeChecked,
      eslintReact.configs['recommended-type-checked'],
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { 'simple-import-sort': simpleImportSort },
    rules: {
      'simple-import-sort/imports': 'error',
      'simple-import-sort/exports': 'error',
      // Types travel as `import { type X }`, so a type-only import never
      // becomes a runtime one by accident.
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/consistent-type-exports': 'error',

      // camelCase names, PascalCase types and components, UPPER_CASE
      // constants. Properties may also be snake_case or PascalCase because
      // they mirror the chain's fields and pallets (`mint_to`, `NftClaims`),
      // and quoted keys are left alone. A leading `_` marks an unused variable
      // or parameter, as in no-unused-vars below. `__NAME__` is the form of
      // Vite's build constants and of the flags set on `window`.
      '@typescript-eslint/naming-convention': [
        'error',
        { selector: 'default', format: ['camelCase'] },
        { selector: 'import', format: null },
        { selector: 'variable', format: ['camelCase', 'UPPER_CASE', 'PascalCase'], leadingUnderscore: 'allow' },
        { selector: 'function', format: ['camelCase', 'PascalCase'] },
        { selector: 'parameter', format: ['camelCase'], leadingUnderscore: 'allow' },
        { selector: 'typeLike', format: ['PascalCase'] },
        {
          selector: [
            'objectLiteralProperty',
            'typeProperty',
            'objectLiteralMethod',
            'typeMethod',
            'classProperty',
            'classMethod',
          ],
          format: ['camelCase', 'snake_case', 'UPPER_CASE', 'PascalCase'],
        },
        { selector: ['objectLiteralProperty', 'typeProperty'], modifiers: ['requiresQuotes'], format: null },
        { selector: ['variable', 'typeProperty'], filter: { regex: '^__[A-Z0-9_]+__$', match: true }, format: null },
      ],

      // An export sits at its declaration, and no file passes on another
      // file's exports, so an import names the file that defines the thing.
      // An exported binding never changes: a value that changes is shared
      // through a function that returns it.
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ExportNamedDeclaration:not([declaration])',
          message: 'Export at the declaration, and import from the file that defines it.',
        },
        { selector: 'ExportAllDeclaration', message: 'Import from the file that defines it.' },
        {
          selector: 'ExportNamedDeclaration > VariableDeclaration[kind!="const"]',
          message: 'Export a const. Share a value that changes through a function that returns it.',
        },
      ],

      // tsconfig has noUncheckedIndexedAccess, so every in-bounds index read
      // in a counted loop is `list[i]!`; the type system already made the
      // `| undefined` honest, and the rule would only add noise on top.
      '@typescript-eslint/no-non-null-assertion': 'off',
      // Numbers and bigints print unambiguously (item indexes, instances,
      // fees, byte lengths); booleans, nullish and `any` still need a word.
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      // `onClick={() => setOpen(true)}` is the React idiom; a brace body
      // there adds nothing. Statement-position cases are still caught.
      '@typescript-eslint/no-confusing-void-expression': [
        'error',
        { ignoreArrowShorthand: true, ignoreVoidOperator: true },
      ],
      // `() => {}` is the no-op callback passed to optional observers.
      '@typescript-eslint/no-empty-function': ['error', { allow: ['arrowFunctions'] }],
      // An empty string is a missing value here (an `<img>`'s currentSrc, a
      // trimmed name, a content-type header), so `||` on strings is meant.
      '@typescript-eslint/prefer-nullish-coalescing': [
        'error',
        { ignorePrimitives: { string: true }, ignoreIfStatements: true },
      ],
      // Deadline and retry wrappers pass the inner rejection through as it
      // came; wrapping it in an Error would hide the typed failures callers
      // match on.
      '@typescript-eslint/prefer-promise-reject-errors': ['error', { allowThrowingUnknown: true }],
      // A comment may sit between the cases of one group.
      'no-fallthrough': ['error', { allowEmptyCase: true }],
      // `const { gone: _gone, ...rest } = obj` drops a key; `_` names a
      // parameter an interface demands but the body does not read.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          ignoreRestSiblings: true,
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      // The hooks plugin carries the React Compiler's own analysis; where
      // eslint-react ships a port of the same check, the React team's copy
      // is the one that runs, so one finding has one source.
      '@eslint-react/exhaustive-deps': 'off',
      '@eslint-react/set-state-in-effect': 'off',
      '@eslint-react/set-state-in-render': 'off',
      '@eslint-react/static-components': 'off',
      '@eslint-react/purity': 'off',
      // Shipped as a warning upstream; here a dependency list that is
      // deliberately partial is marked so at the hook, so the rule can be an error.
      'react-hooks/exhaustive-deps': 'error',
    },
  },

  // Imports go down the layers only: app, features, entities, shared. Code
  // that joins two entities sits a layer up, so the entities import each
  // other in one order.
  { files: ['src/features/**/*.{ts,tsx}'], rules: { 'no-restricted-imports': noImportsFrom(['app']) } },
  ...ENTITIES.map((entity, i) => ({
    files: [`src/entities/${entity}/**/*.{ts,tsx}`],
    rules: { 'no-restricted-imports': noImportsFrom(['app', 'features'], ENTITIES.slice(i + 1)) },
  })),
  {
    files: ['src/shared/**/*.{ts,tsx}'],
    rules: { 'no-restricted-imports': noImportsFrom(['app', 'features', 'entities']) },
  },
  // A function takes at most 4 parameters: values that travel together go in
  // one object. The grid in src/features/grid is not held to this limit.
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/features/grid/**'],
    rules: { 'max-params': ['error', 4] },
  },
  // A function stays small: complexity 20 and 80 lines at most, blank lines and
  // comments not counted. Tests and their fakes are not held to it, as a
  // describe block is a list of cases, and neither is the grid.
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/features/grid/**', 'src/**/*.test.{ts,tsx}', 'src/testing/**'],
    rules: {
      complexity: ['error', 20],
      'max-lines-per-function': ['error', { max: 80, skipBlankLines: true, skipComments: true }],
    },
  },
  // The fakes in src/testing are for tests.
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/**/*.test.{ts,tsx}', 'src/testing/**'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        { patterns: [{ regex: importOf(['testing']), message: 'Only tests import the fakes in src/testing.' }] },
      ],
    },
  },

  // Tests and the chain fakes: Vitest's rules on top; a fake's async method
  // mirrors an interface without awaiting anything, stubs are empty, and
  // fixtures are indexed as known data.
  {
    files: ['src/**/*.test.{ts,tsx}', 'src/**/testing/**/*.{ts,tsx}'],
    extends: [vitest.configs.recommended],
    rules: {
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },

  // Config and build files: plain, no project behind them.
  {
    files: ['*.{js,mjs,ts}', 'scripts/**/*.{js,mjs,ts}'],
    extends: [js.configs.recommended, tseslint.configs.recommended, tseslint.configs.disableTypeChecked],
  },

  eslintConfigPrettier,
]);
