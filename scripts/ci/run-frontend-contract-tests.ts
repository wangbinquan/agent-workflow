// RFC-629: cross-package frontend contract test fast-path executed when a push/PR touches
// backend/e2e/docs files without touching frontend/shared/config files.
// Completeness against ALL `packages/frontend/{tests,src}/**/*.test.ts*` (including transitive
// local helpers) is locked by `packages/backend/tests/architecture/rfc629-ci-optimization-invariants.test.ts`.
import { resolve } from 'node:path'

export const FRONTEND_CROSS_PACKAGE_TESTS = Object.freeze([
  'tests/clarify-reverse-drag-two-edges.test.ts',
  'tests/code-config-api-base.test.ts',
  'tests/code-config-pages.test.tsx',
  'tests/code-policy-pages.test.tsx',
  'tests/diff.test.ts',
  'tests/e2e-harness.test.ts',
  'tests/e2e-visual-infrastructure.test.ts',
  'tests/rfc203-validation-copy.test.ts',
  'tests/rfc208-request-deadline.test.ts',
  'tests/rfc271-export-button.test.tsx',
  'tests/rfc323-adapter-surface-retirement.test.ts',
  'tests/rfc370-v3-hosted-access.test.tsx',
  'tests/session-tab-grep.test.ts',
  'tests/task-wizard-builders.test.ts',
] as const)

export function buildFrontendContractTestCommand(
  files: readonly string[] = FRONTEND_CROSS_PACKAGE_TESTS,
): string[] {
  if (files.length === 0) {
    throw new Error('FRONTEND_CROSS_PACKAGE_TESTS must not be empty')
  }
  return ['bun', 'run', '--filter', '@agent-workflow/frontend', 'test', '--', ...files]
}

if (import.meta.main) {
  const repoRoot = resolve(import.meta.dir, '../..')
  const command = buildFrontendContractTestCommand(FRONTEND_CROSS_PACKAGE_TESTS)
  console.log(
    `Running ${FRONTEND_CROSS_PACKAGE_TESTS.length} cross-package frontend contract tests...`,
  )
  const proc = Bun.spawn(command, {
    cwd: repoRoot,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const exitCode = await proc.exited
  if (exitCode !== 0) process.exit(exitCode)
}
