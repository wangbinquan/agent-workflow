// Regression guard for the repository test entrypoint.
//
// `bunfig.toml` intentionally scopes low-level `bun test` discovery to the
// backend. The documented repository gate must therefore dispatch backend,
// shared, and frontend explicitly; otherwise a local `bun run test` can be
// green while two workspaces were never executed.

import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

interface RootPackageJson {
  packageManager?: string
  scripts?: Record<string, string>
}

function readE2eSpecSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name)
    if (entry.isDirectory()) return readE2eSpecSources(path)
    if (!entry.isFile() || !entry.name.endsWith('.spec.ts')) return []
    return [readFileSync(path, 'utf8')]
  })
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
const backendBunfig = readFileSync(resolve(root, 'packages', 'backend', 'bunfig.toml'), 'utf8')
const ciWorkflow = readFileSync(resolve(root, '.github', 'workflows', 'ci.yml'), 'utf8')
const visualWorkflow = readFileSync(
  resolve(root, '.github', 'workflows', 'visual-regression-nightly.yml'),
  'utf8',
)
const workflowSources = readdirSync(resolve(root, '.github', 'workflows'), {
  withFileTypes: true,
})
  .filter((entry) => entry.isFile() && /\.ya?ml$/.test(entry.name))
  .map((entry) => ({
    name: entry.name,
    source: readFileSync(resolve(root, '.github', 'workflows', entry.name), 'utf8'),
  }))
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
const remainingLaunchRegressions = [
  'rfc122-clarify-directive-dispatch.test.ts',
  'task-start-git-identity.test.ts',
  'task-start-pre-worktree.test.ts',
  'task-start-working-branch.test.ts',
].map((file) => readFileSync(resolve(root, 'packages', 'backend', 'tests', file), 'utf8'))
const sourceGrepRegression = readFileSync(
  resolve(root, 'packages', 'backend', 'tests', 'rfc064-source-grep-guards.test.ts'),
  'utf8',
)
const asyncTestCommandHelper = readFileSync(
  resolve(root, 'packages', 'backend', 'tests', 'helpers', 'testCommand.ts'),
  'utf8',
)
const loggerRegression = readFileSync(
  resolve(root, 'packages', 'backend', 'tests', 'log.test.ts'),
  'utf8',
)
const e2eCommandHelper = readFileSync(resolve(root, 'e2e', 'command.ts'), 'utf8')
const e2eSpecSources = readE2eSpecSources(resolve(root, 'e2e'))
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
  test('every Actions workflow pins the exact Bun release declared by packageManager', () => {
    const expectedVersion = pkg.packageManager?.match(/^bun@(\d+\.\d+\.\d+)$/)?.[1]
    expect(expectedVersion).toBeDefined()

    for (const { name, source } of workflowSources) {
      const setupCount = occurrenceCount(source, 'uses: oven-sh/setup-bun@')
      const configuredVersions = [
        ...source.matchAll(/^\s*bun-version:\s*['"]?([^'"\s]+)['"]?\s*$/gm),
      ].map((match) => match[1]!)

      expect(`${name}: ${configuredVersions.length}`).toBe(`${name}: ${setupCount}`)
      for (const version of configuredVersions) {
        expect(`${name}: bun@${version}`).toBe(`${name}: bun@${expectedVersion}`)
      }
    }
  })

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
    expect(backendBunfig).toContain('preload = ["./tests/setup.ts"]')
    // CI shards the backend suite across runners: each shard is an isolated VM,
    // which is why sharding is safe where `bun test --parallel` deadlocks on the
    // single-instance daemon flock. Both legs keep --isolate --randomize; the
    // ubuntu shards additionally instrument coverage. The local gate
    // (backendPkg.scripts.test, asserted above) stays unsharded.
    expect(ciWorkflow).toContain(
      `run: ${hardenedBunCommand} --seed="$BUN_TEST_SEED" --shard=\${{ matrix.shard }}/4 --coverage --coverage-reporter=text --coverage-reporter=lcov`,
    )
    expect(ciWorkflow).toContain(
      `run: ${hardenedBunCommand} --seed="$BUN_TEST_SEED" --shard=\${{ matrix.shard }}/4\n`,
    )
    expect(ciWorkflow).toContain('name: Derive reproducible backend test seed')
    expect(ciWorkflow).toContain('echo "BUN_TEST_SEED=$seed" >> "$GITHUB_ENV"')
    expect(ciWorkflow).toContain('echo "Backend test seed: $seed"')
  })

  test('logger tests capture through a local sink without mutating process stdout', () => {
    expect(loggerRegression).not.toContain('process.stdout.write =')
    expect(loggerRegression).toContain('setLoggerStdoutWriterForTest(')
    expect(loggerRegression).toContain('stdout failure is best-effort')
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
    // file. Keep both possible blocking layers bounded: fixture Git commands
    // use the async kill-and-reap boundary, while the scheduler owns scenario
    // subprocess deadlines.
    expect(strandedClarifyRegression).not.toContain('execSync(')
    expect(strandedClarifyRegression).not.toContain('execFileSync(')
    expect(strandedClarifyRegression).not.toContain('node:child_process')
    expect(strandedClarifyRegression).toContain('runTestGit(args, GIT_TIMEOUT_MS)')
    expect(strandedClarifyRegression).toContain('await git(')
    expect(strandedClarifyRegression).toContain('defaultPerNodeTimeoutMs: NODE_TIMEOUT_MS')
    expect(strandedClarifyRegression).toContain('defaultNodeRetries: 0')
    expect(strandedClarifyRegression).toContain("abortAllActiveTasks('test-timeout')")
    expect(strandedClarifyRegression).toContain("controller.abort('test-timeout')")
    expect(strandedClarifyRegression).toContain('db.$client.close()')
  })

  test('real-subprocess scenario suites bound local Git, nodes, and whole flows', () => {
    for (const source of [
      clarifyCombinationRegression,
      dynamicWorkflowRegression,
      workgroupRegression,
    ]) {
      expect(source).not.toContain('execSync(')
      expect(source).not.toContain('execFileSync(')
      expect(source).not.toContain('node:child_process')
      expect(source).toContain('runTestGit(args, GIT_TIMEOUT_MS)')
      expect(source).toContain('await git(')
      expect(source).toContain('defaultPerNodeTimeoutMs: NODE_TIMEOUT_MS')
      expect(source).toContain('defaultNodeRetries: DEFAULT_PROTOCOL_RETRY_BUDGET')
      expect(source).toContain("abortAllActiveTasks('test-timeout')")
      expect(source).toContain('db.$client.close()')
    }
    expect(clarifyCombinationRegression).toContain("scenarioController.abort('test-timeout')")
    expect(workgroupRegression).toContain('runTestCommand(')
    expect(workgroupRegression).toContain('timeoutMs: FIXTURE_TIMEOUT_MS')
  })

  test('historical review-iterate regressions bound subprocesses and restore ambient home', () => {
    for (const source of [...reviewIterateRegressions, ...reviewStateRegressions]) {
      expect(source).not.toContain('execSync(')
      expect(source).not.toContain('execFileSync(')
      expect(source).not.toContain('node:child_process')
      expect(source).toContain('runTestGit(args, GIT_TIMEOUT_MS)')
      expect(source).toContain('await git(')
      expect(source).toContain('defaultPerNodeTimeoutMs: NODE_TIMEOUT_MS')
      expect(source).toContain('defaultNodeRetries: DEFAULT_PROTOCOL_RETRY_BUDGET')
      expect(source).toContain("abortAllActiveTasks('test-timeout')")
      expect(source).toContain('db.$client.close()')
      expect(source).toContain('const previousAppHome = process.env.AGENT_WORKFLOW_HOME')
      expect(source).toContain('process.env.AGENT_WORKFLOW_HOME = previousAppHome')
    }

    // The Ubuntu coverage hang after 36a72b92 showed why a timeout option on a
    // synchronous child is not a process boundary: if Bun wedges in that call,
    // neither bun:test nor the watchdog can run. Lock the async kill-and-reap
    // implementation as well as its use by the affected regression family.
    expect(asyncTestCommandHelper).toContain('Bun.spawn({')
    expect(asyncTestCommandHelper).toContain('Promise.race([completed, deadline])')
    expect(asyncTestCommandHelper).toContain("proc.kill('SIGKILL')")
    expect(asyncTestCommandHelper).toContain('await proc.exited')
    expect(asyncTestCommandHelper).toContain('env: nonInteractiveGitEnv()')
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

  test('remaining launch regressions have hard deadlines and the source grep guard fails closed', () => {
    for (const source of remainingLaunchRegressions) {
      expect(source).not.toContain('execSync(')
      expect(source).toContain("execFileSync('git'")
      expect(source).toContain('timeout: GIT_TIMEOUT_MS')
      expect(source).toContain('env: nonInteractiveGitEnv()')
      expect(source).toContain('defaultPerNodeTimeoutMs: NODE_TIMEOUT_MS')
      expect(source).toContain('defaultNodeRetries: DEFAULT_PROTOCOL_RETRY_BUDGET')
      expect(source).toContain("abortAllActiveTasks('test-timeout')")
      expect(source).toContain('isTaskActive(taskId)')
      expect(source).toContain('afterEach(')
    }
    expect(remainingLaunchRegressions[0]).toContain(
      'process.env.AGENT_WORKFLOW_HOME = previousAppHome',
    )
    expect(remainingLaunchRegressions[1]).toContain('const [taskA, taskB] = await Promise.all([')
    expect(remainingLaunchRegressions[1]).toContain('expect(captured).toEqual([')

    expect(sourceGrepRegression).not.toContain('execSync(')
    expect(sourceGrepRegression).toContain("execFileSync('git'")
    expect(sourceGrepRegression).toContain('timeout: GIT_TIMEOUT_MS')
    expect(sourceGrepRegression).toContain('env: nonInteractiveGitEnv()')
    expect(sourceGrepRegression).toContain('.status === 1) return []')
    expect(sourceGrepRegression).toContain('throw error')
  })

  test('every Playwright fixture command uses the shared shell-free bounded boundary', () => {
    expect(e2eCommandHelper).toContain("execFileSync('git'")
    expect(e2eCommandHelper).toContain("execFileSync('sqlite3'")
    expect(e2eCommandHelper).toContain('timeout: COMMAND_TIMEOUT_MS')
    expect(e2eCommandHelper).toContain("GIT_TERMINAL_PROMPT: '0'")
    expect(e2eCommandHelper).toContain("GCM_INTERACTIVE: 'never'")
    expect(e2eCommandHelper).toContain("'commit.gpgsign=false'")
    expect(e2eCommandHelper).toContain("'--no-verify'")

    for (const source of e2eSpecSources) {
      expect(source).not.toContain('child_process')
      expect(source).not.toMatch(/\bexec(?:File)?Sync\s*\(/)
    }

    expect(pkg.scripts?.['lint:repo-ui']).toContain('"e2e/**/*.ts"')
    expect(pkg.scripts?.['format:check:repo-ui']).toContain('"e2e/**/*.{ts,md}"')
    expect(pkg.scripts?.['format:check:repo-ui']).toContain('".github/workflows/*.{yml,yaml}"')
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

  test('visual regression and binary e2e do not require a globally installed opencode', () => {
    expect(visualWorkflow).not.toContain('bun install -g opencode-ai@')
    expect(workflowJob(ciWorkflow, 'e2e')).not.toContain('bun install -g opencode-ai@')
  })

  // ---------------------------------------------------------------------------
  // design/test-guard-audit-2026-07-21 §2 逃逸机制⑥ "门与分支在测试/CI 环境恒不激活".
  //
  // The three tests below lock the CI *topology*, which the audit found to be
  // the precondition for every other guard's credibility: a guard that silently
  // did not run is reported with the same green as a guard that ran clean.
  // ---------------------------------------------------------------------------

  test('path-filtered drift sentinels also fire on push, not only on pull_request', () => {
    // CLAUDE.md mandates main-only development (no PR branches), so a workflow
    // whose only code-coupled trigger is `pull_request` is decoupled from the
    // commits it guards and degenerates into a daily cron. Both opencode
    // integration and the git-protocol e2e sweep were in exactly that state.
    for (const { name, source } of workflowSources) {
      if (!/^ {2}pull_request:/m.test(source)) continue
      expect(`${name}: push trigger = ${/^ {2}push:/m.test(source)}`).toBe(
        `${name}: push trigger = true`,
      )
      // The push filter must be at least as wide as the pull_request one,
      // otherwise the mirror only pretends to cover the same surface.
      const pushBlock = source.match(/^ {2}push:\n(?: {4}.*\n| *\n)*/m)?.[0] ?? ''
      const prBlock = source.match(/^ {2}pull_request:\n(?: {4}.*\n| *\n)*/m)?.[0] ?? ''
      for (const path of [...prBlock.matchAll(/^ {6}- '([^']+)'$/gm)].map((m) => m[1]!)) {
        expect(`${name}: push covers '${path}' = ${pushBlock.includes(`'${path}'`)}`).toBe(
          `${name}: push covers '${path}' = true`,
        )
      }
    }
  })

  test('binary smoke and e2e are not skipped by an unrelated red shard', () => {
    // `needs:` alone makes GitHub SKIP the job when any dependency fails. With
    // several sessions pushing to main concurrently, someone else's red backend
    // shard used to take the shipped-binary smoke, the Playwright suite, the
    // axe a11y sweep and the focus-ring geometry audit down with it — while the
    // run still looked like "those guards had nothing to say".
    for (const job of ['build-binary', 'e2e']) {
      const source = workflowJob(ciWorkflow, job)
      expect(`${job}: ${source.includes('if: ${{ !cancelled() }}')}`).toBe(`${job}: true`)
    }
  })

  test('OpenCode admission and CI define no version floor or ceiling', () => {
    const opencodeUtil = readFileSync(
      resolve(root, 'packages', 'backend', 'src', 'util', 'opencode.ts'),
      'utf8',
    )
    const runtimeBinary = readFileSync(
      resolve(
        root,
        'packages',
        'backend',
        'src',
        'services',
        'runtime',
        'opencode',
        'runtimeBinary.ts',
      ),
      'utf8',
    )
    for (const [name, source] of [
      ['opencode.ts', opencodeUtil],
      ['runtimeBinary.ts', runtimeBinary],
      ...workflowSources.map(({ name, source }) => [name, source] as const),
    ]) {
      expect(source, name).not.toContain('MIN_OPENCODE_VERSION')
      expect(source, name).not.toContain('PINNED_OPENCODE_VERSION')
      expect(source, name).not.toContain('OPENCODE_VERSION:')
    }
  })

  test('low-level Bun discovery and shared process-state setup remain backend-only', () => {
    const bunfig = readFileSync(resolve(root, 'bunfig.toml'), 'utf8')
    expect(bunfig).toMatch(/\[test\][\s\S]*root\s*=\s*"packages\/backend\/tests"/)
    expect(bunfig).toMatch(
      /\[test\][\s\S]*preload\s*=\s*\["\.\/packages\/backend\/tests\/setup\.ts"\]/,
    )
  })
})
