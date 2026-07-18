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
const visualWorkflow = readFileSync(
  resolve(root, '.github', 'workflows', 'visual-regression-nightly.yml'),
  'utf8',
)
const strandedClarifyRegression = readFileSync(
  resolve(root, 'packages', 'backend', 'tests', 'review-clarify-question-phase-stranded.test.ts'),
  'utf8',
)
const clarifyCombinationRegression = readFileSync(
  resolve(root, 'packages', 'backend', 'tests', 'clarify-review-combination-scenarios.test.ts'),
  'utf8',
)
const dynamicWorkflowRegression = readFileSync(
  resolve(root, 'packages', 'backend', 'tests', 'rfc167-dw-e2e.test.ts'),
  'utf8',
)
const workgroupRegression = readFileSync(
  resolve(root, 'packages', 'backend', 'tests', 'rfc186-workgroup-e2e.test.ts'),
  'utf8',
)
const reviewIterateRegressions = [
  'review-iterate-comments-in-prompt.test.ts',
  'review-iterate-file-path-in-prompt.test.ts',
  'review-iterate-drops-prior-clarify-history.test.ts',
].map((file) => readFileSync(resolve(root, 'packages', 'backend', 'tests', file), 'utf8'))
const reviewStateRegressions = [
  'rerun-prior-output-e2e.test.ts',
  'review-iterate-sibling-cascade.test.ts',
  'review-state-machine.test.ts',
  'reviews-iterate-mints-new-run.test.ts',
].map((file) => readFileSync(resolve(root, 'packages', 'backend', 'tests', file), 'utf8'))
const cachedReposRegression = readFileSync(
  resolve(root, 'packages', 'backend', 'tests', 'cached-repos-http.test.ts'),
  'utf8',
)
const startTaskUrlRegression = readFileSync(
  resolve(root, 'packages', 'backend', 'tests', 'start-task-url.test.ts'),
  'utf8',
)
const multipartLaunchRegressions = [
  'rfc107-url-upload-multipart.test.ts',
  'tasks-multipart.test.ts',
].map((file) => readFileSync(resolve(root, 'packages', 'backend', 'tests', file), 'utf8'))
const hardenedBunCommand = 'bun test --isolate --randomize'
const hardenedFrontendCommand = 'vitest run --sequence.shuffle'

function workflowJob(source: string, name: string): string {
  const lines = source.split(/\r?\n/)
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

function workflowJobNames(source: string): string[] {
  const lines = source.split(/\r?\n/)
  const jobsStart = lines.findIndex((line) => line === 'jobs:')
  if (jobsStart < 0) throw new Error('Missing jobs block')
  return lines.slice(jobsStart + 1).flatMap((line) => line.match(/^ {2}([\w-]+):$/)?.[1] ?? [])
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
    const backendJob = workflowJob(ciWorkflow, 'test-backend')
    const frontendJob = workflowJob(ciWorkflow, 'test-frontend')
    const buildBinaryJob = workflowJob(ciWorkflow, 'build-binary')
    const e2eJob = workflowJob(ciWorkflow, 'e2e')

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

  test('the known sync-child regression has hard deadlines', () => {
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

  test('real-subprocess scenario suites bound local Git, nodes, and whole flows', () => {
    for (const source of [
      clarifyCombinationRegression,
      dynamicWorkflowRegression,
      workgroupRegression,
    ]) {
      expect(source).not.toContain('execSync(')
      expect(source).toContain("execFileSync('git'")
      expect(source).toContain('timeout: GIT_TIMEOUT_MS')
      expect(source).toContain('defaultPerNodeTimeoutMs: NODE_TIMEOUT_MS')
      expect(source).toContain('defaultNodeRetries: DEFAULT_PROTOCOL_RETRY_BUDGET')
      expect(source).toContain("abortAllActiveTasks('test-timeout')")
    }
    expect(clarifyCombinationRegression).toContain("scenarioController.abort('test-timeout')")
    expect(workgroupRegression).toContain("execFileSync('bun'")
    expect(workgroupRegression).toContain('timeout: FIXTURE_TIMEOUT_MS')
  })

  test('historical review-iterate regressions bound subprocesses and restore ambient home', () => {
    for (const source of [...reviewIterateRegressions, ...reviewStateRegressions]) {
      expect(source).not.toContain('execSync(')
      expect(source).toContain("execFileSync('git'")
      expect(source).toContain('timeout: GIT_TIMEOUT_MS')
      expect(source).toContain('env: nonInteractiveGitEnv()')
      expect(source).toContain('defaultPerNodeTimeoutMs: NODE_TIMEOUT_MS')
      expect(source).toContain('defaultNodeRetries: DEFAULT_PROTOCOL_RETRY_BUDGET')
      expect(source).toContain("abortAllActiveTasks('test-timeout')")
      expect(source).toContain('const previousAppHome = process.env.AGENT_WORKFLOW_HOME')
      expect(source).toContain('process.env.AGENT_WORKFLOW_HOME = previousAppHome')
    }
  })

  test('URL and multipart launch regressions bound Git and cannot leak background tasks or temp state', () => {
    const activeLaunchRegressions = [startTaskUrlRegression, ...multipartLaunchRegressions]
    for (const source of [cachedReposRegression, ...activeLaunchRegressions]) {
      expect(source).not.toContain('execSync(')
      expect(source).toContain("execFileSync('git'")
      expect(source).toContain('timeout: GIT_TIMEOUT_MS')
      expect(source).toContain('env: nonInteractiveGitEnv()')
      expect(source).toContain('afterEach(')
    }
    for (const source of activeLaunchRegressions) {
      expect(source).toContain('defaultPerNodeTimeoutMs: NODE_TIMEOUT_MS')
      expect(source).toContain('defaultNodeRetries: DEFAULT_PROTOCOL_RETRY_BUDGET')
      expect(source).toContain("abortAllActiveTasks('test-timeout')")
      expect(source).toContain('isTaskActive(taskId)')
    }
    for (const source of [cachedReposRegression, ...multipartLaunchRegressions]) {
      expect(source).toContain('previousAppHome')
      expect(source).toContain('process.env.AGENT_WORKFLOW_HOME = previousAppHome')
    }
  })

  test('every Actions job has an explicit bounded deadline', () => {
    const expectedCiDeadlines = new Map<string, number>([
      ['lint', 15],
      ['test-backend', 15],
      ['test-frontend', 15],
      ['scans', 15],
      ['perf', 15],
      ['docs', 15],
      ['build-binary', 15],
      ['e2e', 20],
    ])
    expect(workflowJobNames(ciWorkflow)).toEqual([...expectedCiDeadlines.keys()])
    for (const [name, minutes] of expectedCiDeadlines) {
      const job = workflowJob(ciWorkflow, name)
      expect(occurrenceCount(job, 'timeout-minutes:')).toBe(1)
      expect(job).toContain(`timeout-minutes: ${minutes}`)
    }

    const visualJob = workflowJob(visualWorkflow, 'visual-regression')
    expect(workflowJobNames(visualWorkflow)).toEqual(['visual-regression'])
    expect(occurrenceCount(visualJob, 'timeout-minutes:')).toBe(1)
    expect(visualJob).toContain('timeout-minutes: 20')
  })

  test('visual regression pins the same opencode version as main CI', () => {
    const ciVersion = ciWorkflow.match(/OPENCODE_VERSION:\s*'([^']+)'/)?.[1]
    const visualVersion = visualWorkflow.match(/OPENCODE_VERSION:\s*'([^']+)'/)?.[1]
    expect(ciVersion).toBeDefined()
    expect(visualVersion).toBe(ciVersion)
    expect(visualWorkflow).toContain('opencode-ai@${{ env.OPENCODE_VERSION }}')
  })

  test('low-level Bun discovery and shared process-state setup remain backend-only', () => {
    const bunfig = readFileSync(resolve(root, 'bunfig.toml'), 'utf8')
    expect(bunfig).toMatch(/\[test\][\s\S]*root\s*=\s*"packages\/backend\/tests"/)
    expect(bunfig).toMatch(
      /\[test\][\s\S]*preload\s*=\s*\["\.\/packages\/backend\/tests\/setup\.ts"\]/,
    )
  })
})
