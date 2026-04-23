// Flat ESLint config for backend Node.js code.
// Frontend has its own config under src/public/dashboard-app/eslint.config.js.
//
// Philosophy: block real security regressions; warn on style; stay quiet on
// legacy monolith code until it's being actively touched (per .context/plan.md
// Workstream 2 / TASKS.md M6).
//
// See .context/decisions/ADR-0003-adopt-typescript.md for the TS roadmap.

const js = require('@eslint/js');
const nodePlugin = require('eslint-plugin-n');
const securityPlugin = require('eslint-plugin-security');
const prettierConfig = require('eslint-config-prettier');

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'coverage/**',
      'dist/**',
      'build/**',
      'data/**',
      'src/public/**',
      'src/migrations/**/*.sql',
      'connectors/**/dist/**',
      'connectors/**/node_modules/**',
      'src/node_modules/**',
      '.context/**',
    ],
  },

  js.configs.recommended,

  {
    files: ['src/**/*.{js,ts}', 'scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: {
        // Node globals
        process: 'readonly',
        Buffer: 'readonly',
        console: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        global: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        clearImmediate: 'readonly',
        module: 'readonly',
        require: 'readonly',
        exports: 'writable',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        fetch: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        queueMicrotask: 'readonly',
        structuredClone: 'readonly',
      },
    },
    plugins: {
      n: nodePlugin,
      security: securityPlugin,
    },
    rules: {
      // --- Blocking correctness ---
      'no-unused-vars': ['error', {
        args: 'after-used',
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      'no-undef': 'error',
      'no-redeclare': 'error',
      'no-fallthrough': 'error',
      'no-unreachable': 'error',
      'no-const-assign': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-cond-assign': ['error', 'always'],
      'no-self-assign': 'error',
      'no-useless-catch': 'warn',
      'no-prototype-builtins': 'warn',
      'no-async-promise-executor': 'error',

      // --- Security rules (from eslint-plugin-security) ---
      'security/detect-child-process': 'warn',
      'security/detect-eval-with-expression': 'error',
      'security/detect-new-buffer': 'error',
      'security/detect-non-literal-regexp': 'warn',
      'security/detect-non-literal-require': 'warn',
      'security/detect-possible-timing-attacks': 'warn',
      'security/detect-pseudoRandomBytes': 'error',
      'security/detect-unsafe-regex': 'warn',

      // --- Node plugin rules ---
      'n/no-deprecated-api': 'warn',
      'n/no-process-exit': 'off',
      'n/no-unpublished-require': 'off',
      'n/no-missing-require': 'off',
      'n/no-extraneous-require': 'off',

      // --- Style (non-blocking; Prettier handles formatting) ---
      'no-console': 'off',
      'no-inner-declarations': 'off',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-useless-escape': 'warn',
      'prefer-const': 'warn',
      eqeqeq: ['warn', 'smart'],
    },
  },

  // Tests: allow the usual Jest globals + relax a few rules.
  {
    files: ['src/tests/**/*.{js,ts}', '**/*.test.{js,ts}'],
    languageOptions: {
      globals: {
        describe: 'readonly',
        it: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        jest: 'readonly',
      },
    },
    rules: {
      'security/detect-non-literal-fs-filename': 'off',
      'security/detect-non-literal-require': 'off',
      'no-unused-vars': 'warn',
    },
  },

  // Security-critical modules: stricter.
  {
    files: [
      'src/lib/encryption.js',
      'src/lib/ssrf-prevention.js',
      'src/lib/csrf-protection.js',
      'src/lib/crypto-security.js',
      'src/lib/oauth-security.js',
      'src/domain/**/*.{js,ts}',
      'src/infra/crypto/**/*.{js,ts}',
      'src/infra/http/**/*.{js,ts}',
      'src/infra/session/**/*.{js,ts}',
    ],
    rules: {
      'security/detect-non-literal-regexp': 'error',
      'security/detect-possible-timing-attacks': 'error',
      'security/detect-unsafe-regex': 'error',
      'no-console': ['warn', { allow: ['error', 'warn'] }],
    },
  },

  // Legacy monolith files being actively dismantled (see TASKS.md M6).
  // Downgrade noise; these files will be extracted, not polished in place.
  {
    files: [
      'src/index.js',
      'src/database.js',
      'src/database-mongodb.js',
      'src/config/database.js',
      'src/gateway/**/*.js',
      'src/utils/encryption.js',
      'src/vault/vault.js',
    ],
    rules: {
      'no-unused-vars': 'warn',
      'no-useless-escape': 'off',
      'security/detect-object-injection': 'off',
      'security/detect-non-literal-fs-filename': 'off',
      'security/detect-non-literal-require': 'off',
      eqeqeq: 'off',
    },
  },

  // Disable all stylistic rules that conflict with Prettier.
  prettierConfig,
];
