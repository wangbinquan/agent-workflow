// Regression guard for the repository test entrypoint.
//
// `bunfig.toml` intentionally scopes low-level `bun test` discovery to the
// backend. The documented repository gate must therefore dispatch backend,
// shared, and frontend explicitly; otherwise a local `bun run test` can be
// green while two workspaces were never executed.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

interface RootPackageJson {
  scripts?: Record<string, string>
}

const root = resolve(import.meta.dir, '..', '..', '..')
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as RootPackageJson
const backendPkg = JSON.parse(
  readFileSync(resolve(root, 'packages', 'backend', 'package.json'), 'utf8'),
) as RootPackageJson
const sharedPkg = JSON.parse(
  readFileSync(resolve(root, 'packages', 'shared', 'package.json'), 'utf8'),
) as RootPackageJson
const frontendPkg = JSON.parse(
  readFileSync(resolve(root, 'packages', 'frontend', 'package.json'), 'utf8'),
) as RootPackageJson
const ciWorkflow = readFileSync(resolve(root, '.github', 'workflows', 'ci.yml'), 'utf8')
const strandedClarifyRegression = readFileSync(
  resolve(root, 'packages', 'backend', 'tests', 'review-clarify-question-phase-stranded.test.ts'),
  'utf8',
)
const hardenedBunCommand = 'bun test --isolate --randomize'
const hardenedFrontendCommand = 'vitest run --sequence.shuffle'

function workflowJob(name: string): string {
  const lines = ciWorkflow.split(/\r?\n/)
  const start = lines.findIndex((line) => line === `  ${name}:`)
  if (start < 0) throw new Error(`Missing CI job: ${name}`)
  const nextJob = lines.findIndex(
    (line, index) =>
      index > start &&
      line.startsWith('  ') &&
      !line.startsWith('    ') &&
      /^[\w-]+:$/.test(line.slice(2)),
  )
  return lines.slice(start, nextJob < 0 ? undefined : nextJob).join('\n')
}

function occurrenceCount(source: string, marker: string): number {
  return source.split(marker).length - 1
}

describe('repository test entrypoint', () => {
  test('bun run test dispatches backend, shared, and frontend in order', () => {
    expect(pkg.scripts?.test).toBe(
      'bun run test:backend && bun run test:shared && bun run test:frontend',
    )
    expect(pkg.scripts?.['test:backend']).toBe(hardenedBunCommand)
    expect(pkg.scripts?.['test:shared']).toBe('bun run --filter @agent-workflow/shared test')
    expect(pkg.scripts?.['test:frontend']).toBe('bun run --filter @agent-workflow/frontend test')
  })

  test('every backend gate isolates files and randomizes execution order', () => {
    expect(backendPkg.scripts?.test).toBe(hardenedBunCommand)
    // CI shards the backend suite across runners: each shard is an isolated VM,
    // which is why sharding is safe where `bun test --parallel` deadlocks on the
    // single-instance daemon flock. Both legs keep --isolate --randomize; the
    // ubuntu shards additionally instrument coverage. The local gate
    // (backendPkg.scripts.test, asserted above) stays unsharded.
    expect(ciWorkflow).toContain(
      `run: ${hardenedBunCommand} --shard=\${{ matrix.shard }}/4 --coverage --coverage-reporter=text --coverage-reporter=lcov`,
    )
    expect(ciWorkflow).toContain(`run: ${hardenedBunCommand} --shard=\${{ matrix.shard }}/4\n`)
  })

  test('shared and frontend gates randomize execution order', () => {
    expect(sharedPkg.scripts?.test).toBe(hardenedBunCommand)
    expect(frontendPkg.scripts?.test).toBe(hardenedFrontendCommand)
    expect(ciWorkflow).toContain('run: bun run --filter @agent-workflow/shared test')
    expect(ciWorkflow).toContain('run: bun run --filter @agent-workflow/frontend test')
  })

  test('CI matrices cover every declared test shard and supported OS', () => {
    const backendJob = workflowJob('test-backend')
    const frontendJob = workflowJob('test-frontend')
    const buildBinaryJob = workflowJob('build-binary')
    const e2eJob = workflowJob('e2e')

    // A denominator in the command is not enough: accidentally shortening the
    // matrix (for example, [1, 2, 3] with /4) makes CI green while one quarter
    // of the suite is never selected.
    expect(backendJob).toContain('fail-fast: false')
    expect(backendJob).toContain('os: [ubuntu-latest, macos-latest]')
    expect(backendJob).toContain('shard: [1, 2, 3, 4]')
    expect(occurrenceCount(backendJob, `--shard=\${{ matrix.shard }}/4`)).toBe(2)

    expect(frontendJob).toContain('fail-fast: false')
    expect(frontendJob).toContain('os: [ubuntu-latest, macos-latest]')
    expect(frontendJob).toContain('shard: [1, 2, 3]')
    expect(occurrenceCount(frontendJob, `--shard=\${{ matrix.shard }}/3`)).toBe(1)

    expect(buildBinaryJob).toContain('fail-fast: false')
    expect(buildBinaryJob).toContain('os: [ubuntu-latest, macos-latest]')

    expect(e2eJob).toContain('needs: build-binary')
    expect(e2eJob).toContain('fail-fast: false')
    expect(e2eJob).toContain('os: [ubuntu-latest, macos-latest]')
    expect(e2eJob).toContain('shard: [1, 2, 3, 4]')
    expect(occurrenceCount(e2eJob, `--shard=\${{ matrix.shard }}/4`)).toBe(1)
  })

  test('backend shards and the known sync-child regression have hard deadlines', () => {
    const backendJob = workflowJob('test-backend')
    expect(backendJob).toContain('timeout-minutes: 15')

    // A macOS shard previously went silent immediately after entering this
    // file. Keep both possible blocking layers bounded: synchronous fixture Git
    // commands and scheduler-owned scenario subprocesses.
    expect(strandedClarifyRegression).not.toContain('execSync(')
    expect(strandedClarifyRegression).toContain("execFileSync('git'")
    expect(strandedClarifyRegression).toContain('timeout: GIT_TIMEOUT_MS')
    expect(strandedClarifyRegression).toContain('defaultPerNodeTimeoutMs: NODE_TIMEOUT_MS')
    expect(strandedClarifyRegression).toContain('defaultNodeRetries: 0')
    expect(strandedClarifyRegression).toContain("abortAllActiveTasks('test-timeout')")
    expect(strandedClarifyRegression).toContain("controller.abort('test-timeout')")
  })

  test('low-level Bun discovery and shared process-state setup remain backend-only', () => {
    const bunfig = readFileSync(resolve(root, 'bunfig.toml'), 'utf8')
    expect(bunfig).toMatch(/\[test\][\s\S]*root\s*=\s*"packages\/backend\/tests"/)
    expect(bunfig).toMatch(
      /\[test\][\s\S]*preload\s*=\s*\["\.\/packages\/backend\/tests\/setup\.ts"\]/,
    )
  })
})
