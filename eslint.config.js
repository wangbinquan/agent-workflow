// ESLint v9 flat config, applies to all packages in the monorepo.
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'

// Shared between the backend blocks below. ⚠️ Flat config REPLACES the whole
// `no-restricted-imports` options object when a later block matches the same
// file (it does NOT merge `patterns`) — a second block that lists only its own
// patterns silently drops these cross-package bans for every file it matches
// (RFC-282 设计门 P1-8). Both backend blocks therefore spread this ONE array;
// tests/rfc282-a1-eslint-boundary.test.ts mutation-proves old and new groups
// in both blocks.
const backendCrossPackagePatterns = [
  {
    group: ['@agent-workflow/frontend', '@agent-workflow/frontend/*'],
    message: 'backend must not import from frontend',
  },
  {
    group: ['react', 'react-dom', '@xyflow/*', 'vite', 'vite/*'],
    message: 'no UI deps in backend',
  },
]

// RFC-282 §4.2 — per-runtime internals are reachable only through
// @/services/runtime (index/types). Relative forms are listed explicitly:
// minimatch treats `.`/`..` as dotfile segments, so `**/` alone does not cover
// `./runtime/opencode/x` (the existing violation shape — runner.ts).
const backendRuntimeFencePatterns = [
  {
    group: [
      '@/services/runtime/opencode/*',
      '@/services/runtime/claudeCode/*',
      '**/runtime/opencode/*',
      '**/runtime/claudeCode/*',
      './runtime/opencode/*',
      './runtime/claudeCode/*',
      '../runtime/opencode/*',
      '../runtime/claudeCode/*',
      '../../services/runtime/opencode/*',
      '../../services/runtime/claudeCode/*',
    ],
    message: 'per-runtime 代码只能经 @/services/runtime（index/types）访问 —— RFC-282 §4.2',
  },
]

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/node_modules/**',
      '**/*.tsbuildinfo',
      'packages/backend/db/migrations/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      // Project-wide pragmatic defaults; tighten as the codebase grows.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-imports': ['warn', { prefer: 'type-imports' }],
      'no-console': 'off',
    },
  },
  // React-specific rules only for tsx/jsx
  {
    files: ['**/*.{tsx,jsx}'],
    plugins: {
      react,
      'react-hooks': reactHooks,
    },
    languageOptions: {
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react/jsx-uses-react': 'off', // not needed for the React 17+ JSX transform
      'react/react-in-jsx-scope': 'off',
    },
    settings: {
      react: { version: 'detect' },
    },
  },
  // Cross-package boundary enforcement (P-X-01 in plan.md):
  // backend cannot import from frontend, and vice versa.
  // Split src vs non-src ONLY so the RFC-282 runtime fence can bind to
  // production code without outlawing unit tests that exercise driver
  // internals; both blocks spread the SAME cross-package array (see header).
  {
    files: ['packages/backend/**'],
    ignores: ['packages/backend/src/**'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [...backendCrossPackagePatterns] }],
    },
  },
  {
    files: ['packages/backend/src/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [...backendCrossPackagePatterns, ...backendRuntimeFencePatterns] },
      ],
    },
  },
  {
    files: ['packages/frontend/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@agent-workflow/backend', '@agent-workflow/backend/*'],
              message: 'frontend must not import from backend',
            },
            {
              group: ['hono', 'drizzle-orm', 'bun:sqlite', 'bun:test'],
              message: 'no backend-only deps in frontend',
            },
          ],
        },
      ],
    },
  },
)
