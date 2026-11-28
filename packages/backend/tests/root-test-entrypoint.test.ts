// Regression guard for the repository test entrypoint.
//
// `bunfig.toml` intentionally scopes low-level `bun test` discovery to the
// backend. The documented repository gate must therefore dispatch backend,
// shared, and frontend explicitly; otherwise a local `bun run test` can be
// green while two workspaces were never executed.

import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'yaml'
import {
  BACKEND_CORE_SHARDS,
  BACKEND_FULL_SHARDS,
  BACKEND_MIGRATION_SHARDS,
} from '../../../scripts/ci/backend-shards'
import { CI_WORK_JOB_IDS } from '../../../scripts/ci/workflow-source'

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
const ciEntryWorkflow = readFileSync(resolve(root, '.github', 'workflows', 'ci.yml'), 'utf8')
const ciWorkflow = readFileSync(resolve(root, '.github', 'workflows', 'ci-work.yml'), 'utf8')
// RFC-629: daily full cross-OS E2E, Windows frontend Vitest, and full-history gitleaks sweep.
const crossOsE2eNightly = readFileSync(
  resolve(root, '.github', 'workflows', 'e2e-cross-os-nightly.yml'),
  'utf8',
)
// 2026-10-14 CI 提速：macOS 后端腿从 ci.yml 移到这条 nightly，命令 / 片数 / 预算原样。
const macosBackendNightly = readFileSync(
  resolve(root, '.github', 'workflows', 'backend-macos-nightly.yml'),
  'utf8',
)
// RFC-627: complete 44-shard dual-engine backend + coverage sweep runs daily and on dispatch.
const fullBackendNightly = readFileSync(
  resolve(root, '.github', 'workflows', 'backend-full-nightly.yml'),
  'utf8',
)
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
// RFC-254 T29 fix: the Bun-only half lives in a child process now, because
// Playwright loads `e2e/*.ts` under NODE and `bun:` is unresolvable there.
const e2eSqliteRunner = readFileSync(resolve(root, 'e2e', 'fixtures', 'sqlite-exec.ts'), 'utf8')
const e2eSpecSources = readE2eSpecSources(resolve(root, 'e2e'))
const hardenedBunCommand = 'bun test --isolate --randomize'
const hardenedSharedCommand = `${hardenedBunCommand} --dots`
const localShardedBackendCommand = 'bun run scripts/test-backend-sharded.ts'
const hardenedFrontendCommand = 'vitest run --sequence.shuffle'
const boundedGateFrontendCommand = `${hardenedFrontendCommand} --maxWorkers=2`

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

function workflowStep(source: string, name: string): string {
  const lines = source.split(/\r?\n/)
  const start = lines.findIndex((line) => line === `      - name: ${name}`)
  if (start < 0) throw new Error(`Missing workflow step: ${name}`)
  const nextStep = lines.findIndex((line, index) => index > start && line.startsWith('      - '))
  return lines.slice(start, nextStep < 0 ? undefined : nextStep).join('\n')
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

// RFC-627: workflow-level single concurrency group per ref (no `queue: max`).
// In-progress runs finish untouched; superseded pending runs are replaced so
// queues stay bounded at 1 running + 1 pending. Manual workflow_dispatch runs
// use an isolated group keyed by run_id.
const ciWorkflowConcurrencyGroup =
  "${{ github.event_name == 'workflow_dispatch' && " +
  "format('{0}-manual-{1}', github.workflow, github.run_id) || " +
  "format('{0}-{1}', github.workflow, github.ref) }}"

function isBoundedCiWorkflowConcurrency(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const concurrency = value as Record<string, unknown>
  return (
    typeof concurrency.group === 'string' &&
    concurrency.group.replace(/\s+/g, ' ').trim() === ciWorkflowConcurrencyGroup &&
    concurrency.queue === undefined &&
    concurrency['cancel-in-progress'] === false
  )
}

/** Numeric literal of a `const NAME = 12_345` declaration in the e2e helper. */
function e2eConstant(source: string, name: string, where: string): number {
  const literal = source.match(new RegExp(`const ${name} = ([\\d_]+)`))?.[1]
  if (literal === undefined) throw new Error(`Missing ${name} in ${where}`)
  return Number(literal.replaceAll('_', ''))
}

describe('repository test entrypoint', () => {
  test('only eligible successful CI and nightly completions can supersede a timing collector', () => {
    const workflow = parse(readFileSync(resolve(root, '.github/workflows/ci-timings.yml'), 'utf8'))
    expect(workflow.concurrency).toBeUndefined()
    expect(workflow.on.workflow_run).toEqual({
      workflows: ['CI', 'backend-full-nightly', 'e2e-cross-os-nightly'],
      types: ['completed'],
    })
    const job = workflow.jobs.collect
    expect(job.if).toContain("github.event.workflow_run.conclusion == 'success'")
    expect(job.if).toContain("github.event.workflow_run.head_branch == 'main'")
    expect(job.if).toContain(
      'github.event.workflow_run.head_repository.full_name == github.repository',
    )
    expect(job.if).toContain("github.event.workflow_run.name == 'CI'")
    expect(job.if).toContain("github.event.workflow_run.name == 'backend-full-nightly'")
    expect(job.if).toContain("github.event.workflow_run.name == 'e2e-cross-os-nightly'")
    expect(job.if).toContain("github.event.workflow_run.event == 'push'")
    expect(job.if).toContain("github.event.workflow_run.event == 'schedule'")
    expect(job.if).toContain("github.event.workflow_run.event == 'workflow_dispatch'")
    expect(job.concurrency).toEqual({
      group: 'ci-timing-refresh-${{ github.event.workflow_run.name }}',
      'cancel-in-progress': true,
    })
    expect(workflow.permissions).toEqual({ actions: 'read', contents: 'read' })
  })

  test('CI bounds queue depth at workflow level without cancelling in-progress runs', () => {
    const workflow = parse(ciEntryWorkflow)
    expect(isBoundedCiWorkflowConcurrency(workflow.concurrency)).toBe(true)
    expect(workflow.jobs['full-ci'].concurrency).toBeUndefined()
    expect(workflow.jobs['full-ci'].uses).toBe('./.github/workflows/ci-work.yml')
    expect(workflow.jobs['ci-required'].concurrency).toBeUndefined()
    const calculation = parse(ciWorkflow)
    expect(calculation.concurrency).toBeUndefined()
    expect(Object.keys(calculation.on)).toEqual(['workflow_call'])
    for (const job of Object.values(calculation.jobs) as { concurrency?: unknown }[])
      expect(job.concurrency).toBeUndefined()
    expect(workflow.on.push).toEqual({ branches: ['main'] })
    expect(workflow.on.pull_request).toEqual({ branches: ['main'] })
    expect(workflow.on.workflow_dispatch.inputs.mode).toMatchObject({
      type: 'choice',
      options: ['full', 'auto'],
      default: 'full',
    })
  })

  test('actionlint requires no compatibility ignore file once queue: max is retired', () => {
    expect(existsSync(resolve(root, '.github/actionlint.yaml'))).toBe(false)
  })

  test('CI workflow concurrency rejects unbounded queues, mid-run cancellation, and unisolated manual runs', () => {
    const concurrency = parse(ciEntryWorkflow).concurrency as Record<string, unknown>
    for (const invalid of [
      { ...concurrency, queue: 'max' },
      { ...concurrency, 'cancel-in-progress': true },
      { ...concurrency, group: '${{ github.workflow }}-${{ github.ref }}-${{ github.sha }}' },
      { ...concurrency, group: ciWorkflowConcurrencyGroup.replaceAll('run_id', 'run_attempt') },
      { ...concurrency, group: '${{ github.workflow }}-${{ github.ref }}' },
    ]) {
      expect(isBoundedCiWorkflowConcurrency(invalid)).toBe(false)
    }
  })

  test('CI feedback workflow is retired and ci-work.yml:lint runs every static gate with explicit per-PID exit checks', () => {
    expect(existsSync(resolve(root, '.github', 'workflows', 'ci-feedback.yml'))).toBe(false)
    expect(workflowJob(ciEntryWorkflow, 'ci-required')).not.toContain('static-feedback')
    const lintJob = workflowJob(ciWorkflow, 'lint')
    for (const marker of [
      'bun run format:check',
      'bun run depcheck',
      'bun run --filter @agent-workflow/shared test',
      'bun run test:system-mocks',
      'bun run lint',
      'bun run typecheck',
      'wait "$pid_format"',
      'wait "$pid_depcheck"',
      'wait "$pid_shared"',
      'wait "$pid_mocks"',
      'wait "$pid_lint"',
      'wait "$pid_typecheck"',
      'exit "$failed"',
    ]) {
      expect(lintJob, marker).toContain(marker)
    }
  })

  test('ci-work.yml:lint keeps scoped Prettier, ESLint, and TypeScript incremental caches under node_modules/.cache', () => {
    const expectedVersion = pkg.packageManager?.match(/^bun@(\d+\.\d+\.\d+)$/)?.[1]
    const steps = parse(ciWorkflow).jobs.lint.steps as {
      uses?: string
      with?: { path?: string; key?: string; 'restore-keys'?: string }
    }[]
    const qualityCaches = steps.filter((step) => step.with?.path?.includes('node_modules/.cache/'))
    expect(qualityCaches).toHaveLength(3)
    const prettierPrefix =
      `prettier-v1-\${{ runner.os }}-bun-${expectedVersion}-` +
      "${{ hashFiles('bun.lock', 'package.json', 'packages/*/package.json', '**/.prettier*', '**/prettier.config.*', '!**/node_modules/**') }}-"
    const eslintPrefix =
      `eslint-v1-\${{ runner.os }}-bun-${expectedVersion}-` +
      "${{ hashFiles('bun.lock', 'package.json', 'packages/*/package.json', 'eslint.config.js') }}-"
    const tscPrefix =
      `tsc-v1-\${{ runner.os }}-bun-${expectedVersion}-` +
      "${{ hashFiles('bun.lock', 'package.json', 'packages/*/package.json', 'tsconfig.base.json', 'packages/*/tsconfig.json') }}-"
    expect(qualityCaches.map((step) => ({ uses: step.uses, with: step.with }))).toEqual([
      {
        uses: 'actions/cache@v6',
        with: {
          path: 'node_modules/.cache/prettier',
          key: prettierPrefix + '${{ github.sha }}',
          'restore-keys': prettierPrefix,
        },
      },
      {
        uses: 'actions/cache@v6',
        with: {
          path: 'node_modules/.cache/eslint',
          key: eslintPrefix + '${{ github.sha }}',
          'restore-keys': eslintPrefix,
        },
      },
      {
        uses: 'actions/cache@v6',
        with: {
          path: 'node_modules/.cache/tsc',
          key: tscPrefix + '${{ github.sha }}',
          'restore-keys': tscPrefix,
        },
      },
    ])
  })

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

  test('bun run test dispatches backend, shared, frontend, and system mocks in order', () => {
    expect(pkg.scripts?.test).toBe(
      'bun run test:backend && bun run test:shared && bun run test:frontend && bun run test:system-mocks',
    )
    expect(pkg.scripts?.['test:backend']).toBe(localShardedBackendCommand)
    expect(pkg.scripts?.['test:backend:serial']).toBe(hardenedBunCommand)
    expect(pkg.scripts?.['test:shared']).toBe('bun run --filter @agent-workflow/shared test')
    expect(pkg.scripts?.['test:frontend']).toBe('bun run --filter @agent-workflow/frontend test')
    expect(pkg.scripts?.['test:system-mocks']).toBe(
      'bun run --filter @agent-workflow/system-mocks test',
    )
    expect(pkg.scripts?.['test:frontend:gate']).toBe(
      'bun run --filter @agent-workflow/frontend test:gate',
    )
    expect(frontendPkg.scripts?.['test:gate']).toBe(boundedGateFrontendCommand)
    expect(pkg.scripts?.['gate:local']).toBe('bun run scripts/local-gate.ts')
  })

  test('local quality gates keep content caches under ignored dependency storage', () => {
    const lintScripts = [
      ['repo UI', pkg.scripts?.['lint:repo-ui'], 'node_modules/.cache/eslint/repo-ui'],
      ['backend', backendPkg.scripts?.lint, '../../node_modules/.cache/eslint/backend'],
      ['shared', sharedPkg.scripts?.lint, '../../node_modules/.cache/eslint/shared'],
      ['frontend', frontendPkg.scripts?.lint, '../../node_modules/.cache/eslint/frontend'],
    ] as const

    for (const [name, script, cacheLocation] of lintScripts) {
      expect(script, name).toContain('--cache --cache-strategy content')
      expect(script, name).toContain(`--cache-location ${cacheLocation}`)
    }

    const formatScripts = [
      ['packages', pkg.scripts?.['format:check'], 'node_modules/.cache/prettier/packages'],
      ['repo UI', pkg.scripts?.['format:check:repo-ui'], 'node_modules/.cache/prettier/repo-ui'],
    ] as const

    for (const [name, script, cacheLocation] of formatScripts) {
      expect(script, name).toContain('--cache --cache-strategy content')
      expect(script, name).toContain(`--cache-location ${cacheLocation}`)
    }
  })

  test('every backend gate isolates files and randomizes execution order', () => {
    expect(backendPkg.scripts?.test).toBe(hardenedBunCommand)
    expect(backendBunfig).toContain('preload = ["./tests/setup.ts"]')
    // RFC-627: per-push CI shards backend tests through deterministic LPT planning
    // (`run-backend-shard.ts`: 16 core SQLite shards + conditional 28 dual-engine migration
    // shards), while `backend-full-nightly.yml` runs the complete 44-shard dual-engine suite
    // with `--coverage` and Codecov upload. Every leg preserves `--isolate --randomize`.
    expect(ciWorkflow).toContain(
      'run: bun scripts/ci/run-backend-shard.ts --tier=core --shard=${{ matrix.shard }}/${{ matrix.shards }} --seed="$BUN_TEST_SEED" --timings-out="$RUNNER_TEMP/backend-core-timings.json"',
    )
    expect(ciWorkflow).toContain(
      'run: bun scripts/ci/run-backend-shard.ts --tier=migration --shard=${{ matrix.shard }}/${{ matrix.shards }} --seed="$BUN_TEST_SEED" --timings-out="$RUNNER_TEMP/backend-migration-timings.json"',
    )
    const uploadTimings = ciWorkflow
      .slice(ciWorkflow.indexOf('- name: Upload measured backend test timings (ubuntu shards)'))
      .split('\n      - name:')[0]!
    expect(uploadTimings).toContain("if: success() && matrix.os == 'ubuntu-latest'")
    expect(uploadTimings).not.toContain('failure()')
    expect(uploadTimings).toContain('name: backend-core-timings-${{ matrix.shard }}')
    expect(uploadTimings).toContain('path: ${{ runner.temp }}/backend-core-timings.json')

    expect(fullBackendNightly).toContain(
      'run: bun scripts/ci/run-backend-shard.ts --tier=all --shard=${{ matrix.shard }}/${{ matrix.shards }} --seed="$BUN_TEST_SEED" --timings-out="$RUNNER_TEMP/backend-full-timings.json" --coverage',
    )
    const nightlyUploadTimings = fullBackendNightly
      .slice(
        fullBackendNightly.indexOf(
          '- name: Upload measured backend test timings (nightly full shards)',
        ),
      )
      .split('\n      - name:')[0]!
    expect(nightlyUploadTimings).toContain('if: success()')
    expect(nightlyUploadTimings).not.toContain('failure()')
    expect(nightlyUploadTimings).toContain('name: backend-full-timings-${{ matrix.shard }}')
    expect(nightlyUploadTimings).toContain('path: ${{ runner.temp }}/backend-full-timings.json')
    // The file must stay Bun's v1 shape and keep weights for the heavy suites that caused it.
    const timings = JSON.parse(
      readFileSync(resolve(root, '.github', 'backend-test-timings.json'), 'utf8'),
    ) as { version: number; files: Record<string, number> }
    expect(timings.version).toBe(1)
    for (const path of [
      'packages/backend/tests/release-upgrade-matrix-51-v0_18_18-postgresql.test.ts',
      'packages/backend/tests/rfc398-auto-upgrade-resume-postgresql-phase-frozen.test.ts',
      'packages/backend/tests/rfc398-postgresql-bridge-v0_18_18.test.ts',
    ])
      expect(timings.files[path]).toBeGreaterThan(30_000)
    // Durations are whole-file wall clock (module load, hooks and tests). The first file summed
    // per-test times instead: this suite's tests take 1.7 s but its setup about 27 s, so the
    // RFC-395 suites looked short, packed onto shards 23-25 and all three were cancelled at the
    // 15-minute budget (run 41301089649).
    expect(timings.files['packages/backend/tests/rfc395-v1-golden.test.ts']).toBeGreaterThan(10_000)
    expect(
      Object.entries(timings.files).every(
        ([path, ms]) =>
          path.startsWith('packages/backend/tests/') && Number.isInteger(ms) && ms >= 0,
      ),
    ).toBe(true)
    expect(macosBackendNightly).toContain(
      `run: ${hardenedBunCommand} --seed="$BUN_TEST_SEED" --shard=\${{ matrix.shard }}/\${{ matrix.shards }}\n`,
    )
    for (const workflow of [ciWorkflow, fullBackendNightly, macosBackendNightly]) {
      expect(workflow).toContain('name: Derive reproducible backend test seed')
      expect(workflow).toContain('echo "BUN_TEST_SEED=$seed" >> "$GITHUB_ENV"')
      expect(workflow).toContain('echo "Backend test seed: $seed"')
    }
  })

  test('logger tests capture through a local sink without mutating process stdout', () => {
    expect(loggerRegression).not.toContain('process.stdout.write =')
    expect(loggerRegression).toContain('setLoggerStdoutWriterForTest(')
    expect(loggerRegression).toContain('stdout failure is best-effort')
  })

  test('shared and frontend gates randomize execution order', () => {
    expect(sharedPkg.scripts?.test).toBe(hardenedSharedCommand)
    expect(frontendPkg.scripts?.test).toBe(hardenedFrontendCommand)
    expect(workflowJob(ciWorkflow, 'lint')).toContain(
      'bun run --filter @agent-workflow/shared test',
    )
    expect(workflowJob(ciWorkflow, 'test-frontend')).toContain(
      'run: bun run --filter @agent-workflow/frontend test -- --shard=${{ matrix.shard }}/3',
    )
  })

  test('CI matrices cover every declared test shard and supported OS', () => {
    const backendJob = workflowJob(ciWorkflow, 'test-backend')
    const frontendJob = workflowJob(ciWorkflow, 'test-frontend')
    const buildBinaryJob = workflowJob(ciWorkflow, 'build-binary')
    const e2eJob = workflowJob(ciWorkflow, 'e2e')
    const buildPlatforms = [
      // 2026-11-05: the Linux build + browser legs pin ubuntu-24.04 (Playwright 1.60.0 cannot
      // install Chromium on ubuntu-latest = ubuntu-26.04); see ci-playwright-runner-image.test.ts.
      { job: 'build-binary', os: 'ubuntu-24.04', steps: '&build-binary-steps' },
      { job: 'build-binary-macos', os: 'macos-latest', steps: '*build-binary-steps' },
      { job: 'build-binary-windows', os: 'windows-latest', steps: '*build-binary-steps' },
    ] as const
    const e2ePlatforms = [
      {
        job: 'e2e',
        build: 'build-binary',
        os: 'ubuntu-24.04',
        shards: '[1, 2, 3]',
        total: 3,
        tier: 'pr-full',
      },
      // RFC-629: per-push macOS/Windows run the 19-spec OS-core subset across 2 shards;
      // full 3/4-shard cross-OS pr-full sweeps run daily in e2e-cross-os-nightly.yml.
      {
        job: 'e2e-macos',
        build: 'build-binary-macos',
        os: 'macos-latest',
        shards: '[1, 2]',
        total: 2,
        tier: 'os-core',
      },
      {
        job: 'e2e-windows',
        build: 'build-binary-windows',
        os: 'windows-latest',
        shards: '[1, 2]',
        total: 2,
        tier: 'os-core',
      },
    ] as const

    // A denominator in the command is not enough: accidentally shortening the
    // matrix (for example, [1, 2, 3] with /4) makes CI green while one quarter
    // of the suite is never selected.
    expect(backendJob).toContain('fail-fast: false')
    const matrix: {
      os: string[]
      shard: number[]
      shards: number[]
      include?: { os: string; shard: number; shards: number }[]
    } = parse(backendJob)['test-backend'].strategy.matrix
    expect(matrix.include).toBeUndefined()
    const migrationJob = workflowJob(ciWorkflow, 'test-backend-migration')
    expect(migrationJob).toContain('fail-fast: false')
    const migrationMatrix: {
      os: string[]
      shard: number[]
      shards: number[]
      include?: unknown
    } = parse(migrationJob)['test-backend-migration'].strategy.matrix
    expect(migrationMatrix.include).toBeUndefined()
    const fullNightlyJob: {
      'runs-on': string
      strategy: { 'fail-fast': boolean; matrix: { shard: number[]; shards: number[] } }
    } = parse(fullBackendNightly).jobs['test-backend-full']
    expect(fullNightlyJob['runs-on']).toBe('ubuntu-latest')
    expect(fullNightlyJob.strategy['fail-fast']).toBe(false)
    const macosJob: {
      'runs-on': string
      strategy: { 'fail-fast': boolean; matrix: { shard: number[]; shards: number[] } }
    } = parse(macosBackendNightly).jobs['test-backend-macos']
    expect(macosJob['runs-on']).toBe('macos-latest')
    expect(macosJob.strategy['fail-fast']).toBe(false)

    expect(matrix.os).toEqual(['ubuntu-latest'])
    expect(matrix.shard).toEqual(
      Array.from({ length: BACKEND_CORE_SHARDS }, (_, index) => index + 1),
    )
    expect(matrix.shards).toEqual([BACKEND_CORE_SHARDS])

    expect(migrationMatrix.os).toEqual(['ubuntu-latest'])
    expect(migrationMatrix.shard).toEqual(
      Array.from({ length: BACKEND_MIGRATION_SHARDS }, (_, index) => index + 1),
    )
    expect(migrationMatrix.shards).toEqual([BACKEND_MIGRATION_SHARDS])

    expect(fullNightlyJob.strategy.matrix.shard).toEqual(
      Array.from({ length: BACKEND_FULL_SHARDS }, (_, index) => index + 1),
    )
    expect(fullNightlyJob.strategy.matrix.shards).toEqual([BACKEND_FULL_SHARDS])

    expect(macosJob.strategy.matrix.shard).toEqual(
      Array.from({ length: 18 }, (_, index) => index + 1),
    )
    expect(macosJob.strategy.matrix.shards).toEqual([18])

    expect(backendJob).toContain(
      'name: Backend tests (${{ matrix.os }} shard ${{ matrix.shard }}/${{ matrix.shards }})',
    )
    expect(backendJob).not.toContain('--coverage')
    expect(backendJob).not.toContain('codecov/codecov-action')
    expect(occurrenceCount(backendJob, `--shard=\${{ matrix.shard }}/\${{ matrix.shards }}`)).toBe(
      1,
    )
    expect(
      occurrenceCount(migrationJob, `--shard=\${{ matrix.shard }}/\${{ matrix.shards }}`),
    ).toBe(1)
    expect(
      occurrenceCount(fullBackendNightly, `--shard=\${{ matrix.shard }}/\${{ matrix.shards }}`),
    ).toBe(1)
    expect(
      occurrenceCount(macosBackendNightly, `--shard=\${{ matrix.shard }}/\${{ matrix.shards }}`),
    ).toBe(1)
    const coverageStep = workflowStep(
      fullBackendNightly,
      'Upload backend coverage to Codecov (nightly full shards)',
    )
    expect(coverageStep).toContain('files: ./coverage/lcov.info')
    expect(coverageStep).toContain('flags: backend-shard-${{ matrix.shard }}')
    expect(coverageStep).toContain('name: backend-coverage-shard-${{ matrix.shard }}')
    const required = workflowJob(ciEntryWorkflow, 'ci-required')
    expect(required).toContain('needs: [detect-changes, docs-fast-gate, full-ci]')
    expect(required).toContain(
      "TEST_BACKEND_RESULT: ${{ needs['full-ci'].outputs['test-backend'] }}",
    )
    expect(required).toContain(
      "TEST_BACKEND_MIGRATION_RESULT: ${{ needs['full-ci'].outputs['test-backend-migration'] }}",
    )

    expect(frontendJob).toContain('fail-fast: false')
    // RFC-629: per-push frontend runs on Ubuntu with dynamic shard count (3 full shards when
    // frontend/shared/config changed, 1 contract shard for backend-only diffs); Windows 3-shard
    // Vitest runs daily in e2e-cross-os-nightly.yml and e2e-harness.test.ts runs in windows-platform.yml.
    expect(frontendJob).toContain('os: [ubuntu-latest]')
    expect(frontendJob).toContain(
      "shard: ${{ fromJSON(inputs.run_frontend_full && '[1, 2, 3]' || '[1]') }}",
    )
    expect(occurrenceCount(frontendJob, `--shard=\${{ matrix.shard }}/3`)).toBe(1)
    expect(frontendJob).toContain('bun scripts/ci/run-frontend-contract-tests.ts')

    const windowsFrontendNightly = workflowJob(crossOsE2eNightly, 'test-frontend-windows')
    expect(windowsFrontendNightly).toContain('runs-on: windows-latest')
    expect(windowsFrontendNightly).toContain('shard: [1, 2, 3]')
    expect(occurrenceCount(windowsFrontendNightly, `--shard=\${{ matrix.shard }}/3`)).toBe(1)
    expect(workflowJob(crossOsE2eNightly, 'e2e-macos-full')).toContain('shard: [1, 2, 3]')
    expect(workflowJob(crossOsE2eNightly, 'e2e-macos-full')).toContain('AW_E2E_TIER: pr-full')
    expect(workflowJob(crossOsE2eNightly, 'e2e-macos-full')).toContain("AW_E2E_WORKERS: '3'")
    expect(workflowJob(crossOsE2eNightly, 'e2e-windows-full')).toContain('shard: [1, 2, 3, 4]')
    expect(workflowJob(crossOsE2eNightly, 'e2e-windows-full')).toContain('AW_E2E_TIER: pr-full')
    expect(workflowJob(crossOsE2eNightly, 'gitleaks-full-history')).toContain('fetch-depth: 0')

    for (const platform of buildPlatforms) {
      const job = workflowJob(ciWorkflow, platform.job)
      expect(job).toContain('fail-fast: false')
      expect(job).toContain(`os: [${platform.os}]`)
      expect(job).toContain(`steps: ${platform.steps}`)
      expect(job).toContain(
        'name: Build production binary + e2e artifact (smoke) (${{ matrix.os }})',
      )
    }
    // The RFC-224 supervisor smoke drives the BWRAP supervisor with
    // `/usr/bin/true`; neither exists on Windows, so the windows leg takes the
    // artifact and skips that step. `windows-platform.yml` drives `doctor` and
    // the compiled stub there instead.
    expect(buildBinaryJob).toContain("if: runner.os != 'Windows'")

    for (const platform of e2ePlatforms) {
      const job = workflowJob(ciWorkflow, platform.job)
      expect(job).toContain(`needs: ${platform.build}`)
      expect(job).toContain(
        `if: \${{ !cancelled() && inputs.run_e2e && needs.${platform.build}.result == 'success' }}`,
      )
      expect(job).toContain('fail-fast: false')
      expect(job).toContain(`os: [${platform.os}]`)
      expect(job).toContain(`shard: ${platform.shards}`)
      expect(job).toContain(`shards: [${platform.total}]`)
      expect(job).toContain(`AW_E2E_TIER: ${platform.tier}`)
      expect(job).toContain(
        'name: Playwright e2e (${{ matrix.os }} shard ${{ matrix.shard }}/${{ matrix.shards }})',
      )
    }
    expect(e2eJob).toContain('steps: &e2e-steps')
    expect(workflowJob(ciWorkflow, 'e2e-macos')).toContain('steps: *e2e-steps')
    expect(workflowJob(ciWorkflow, 'e2e-macos')).toContain("AW_E2E_WORKERS: '3'")
    expect(workflowJob(ciWorkflow, 'e2e')).not.toContain('AW_E2E_WORKERS')
    expect(workflowJob(ciWorkflow, 'e2e-windows')).not.toContain('AW_E2E_WORKERS')
    expect(workflowJob(ciWorkflow, 'e2e-windows')).toContain('steps: *e2e-steps')
    // Native discovery retains the same filters; the planner consumes the one
    // complete matrix denominator. Execution must not shard the selected files again.
    expect(occurrenceCount(e2eJob, '--shard=${{ matrix.shard }}/${{ matrix.shards }}')).toBe(1)
    expect(e2eJob).toContain('bun run scripts/ci/plan-e2e-shards.ts')
    expect(e2eJob).toContain('--tier "$AW_E2E_TIER"')
    expect(occurrenceCount(e2eJob, '--list --reporter=json --project=chromium')).toBe(2)
    expect(occurrenceCount(e2eJob, '--config=playwright.ci.config.ts --project=chromium')).toBe(2)
    expect(e2eJob).not.toContain('bun run e2e -- --shard=')
    expect(e2eJob).toContain('AW_E2E_WINDOWS_EXCLUDE')
  })

  test('Windows e2e skips only the slow Bun download cache', () => {
    const e2eJob = workflowJob(ciWorkflow, 'e2e')
    const bunCacheStep = workflowStep(e2eJob, 'Cache bun package downloads')
    const installStep = workflowStep(e2eJob, 'Install dependencies')
    const browserCacheStep = workflowStep(e2eJob, 'Cache Playwright browsers')

    expect(bunCacheStep).toContain('uses: actions/cache@v6')
    expect(bunCacheStep).toContain("if: runner.os != 'Windows'")
    expect(installStep).not.toMatch(/^ {8}if:/m)
    expect(installStep).toContain('run: bun install --frozen-lockfile')
    expect(browserCacheStep).not.toMatch(/^ {8}if:/m)
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

  test('every run step in an OS-matrix job declares its shell', () => {
    // RFC-254 T31 — the default shell on a windows runner is pwsh, on
    // ubuntu/macOS it is bash. A step in a job whose matrix spans operating
    // systems therefore runs under two different LANGUAGES unless it says
    // which one it wants, and the POSIX-shaped ones simply fail on the windows
    // leg with a syntax error that names neither the shell nor the matrix.
    //
    // Declaring `shell: bash` is behaviour-preserving on the POSIX legs (the
    // only delta versus the implicit default is `-o pipefail`, and none of
    // these steps contain a pipeline — checked when this was introduced).
    // EVERY workflow, not just ci.yml: the nightlies carry OS matrices too, and
    // the trap springs the moment one of them grows a windows entry.
    const workflowsDir = resolve(root, '.github', 'workflows')
    const offenders: string[] = []
    const blocks = readdirSync(workflowsDir)
      .filter((name) => name.endsWith('.yml'))
      .flatMap((name) =>
        readFileSync(resolve(workflowsDir, name), 'utf8')
          .split(/\n {2}(?=[a-z0-9-]+:\n)/)
          .map((block) => ({ name, block })),
      )
    for (const { name: workflowName, block: jobBlock } of blocks) {
      if (!jobBlock.includes('os: [') || !jobBlock.includes('runs-on: ${{ matrix.os }}')) continue
      const jobName = `${workflowName}:${jobBlock.split('\n')[0]?.replace(':', '') ?? '?'}`
      for (const step of jobBlock.split('\n      - name: ').slice(1)) {
        const body = step.split('\n      - name:')[0] ?? ''
        if (!/^\s+run:/m.test(body)) continue
        if (/^\s+shell:\s/m.test(body)) continue
        offenders.push(`${jobName}: ${step.split('\n')[0]}`)
      }
    }
    expect(offenders, 'an OS-matrix step must say which shell it speaks').toEqual([])
  })

  test('no apostrophe hides inside a single-quoted `bun -e` block in a workflow', () => {
    // Twice now a JS comment containing an English possessive ("the binary's
    // own …") has terminated the SHELL's single-quoted string that wraps the
    // script, turning the rest of the JS into shell commands. It does not look
    // like a quoting bug in review — it looks like a sentence — and the symptom
    // is a wall of shellcheck SC1127s plus a build-smoke failure whose message
    // never mentions quotes.
    for (const file of readdirSync(resolve(root, '.github', 'workflows')).filter((n) =>
      n.endsWith('.yml'),
    )) {
      const source = readFileSync(resolve(root, '.github', 'workflows', file), 'utf8')
      for (const block of source.matchAll(/bun -e '([\s\S]*?)\n\s*'\n/g)) {
        const offenders = (block[1] ?? '')
          .split('\n')
          .map((line, index) => ({ line, index }))
          .filter((entry) => entry.line.includes("'"))
        expect(
          offenders.map((entry) => `${file}:+${entry.index + 1} ${entry.line.trim()}`),
          'an apostrophe here ends the shell string early',
        ).toEqual([])
      }
    }
  })

  test('every Playwright fixture command uses the shared shell-free bounded boundary', () => {
    expect(e2eCommandHelper).toContain("execFileSync('git'")
    // RFC-254 T29: fixture SQL runs through Bun's EMBEDDED SQLite, not the
    // `sqlite3` CLI — the CLI is absent from the windows-latest runner image,
    // and it defaulted to `busy_timeout = 0` against a live daemon holding the
    // write lock.
    //
    // It runs one process boundary away, and that placement is itself the
    // subject of a lock: `e2e/command.ts` is loaded by Playwright's NODE runner,
    // where importing `bun:sqlite` kills the whole suite at load time (it did —
    // 86ebbf2d, four shards down for four commits). So the engine belongs to the
    // child and the parent may only spawn it.
    expect(e2eCommandHelper).not.toContain("from 'bun:sqlite'")
    expect(e2eCommandHelper).not.toContain("execFileSync('sqlite3'")
    expect(e2eCommandHelper).toContain('sqlite-exec.ts')
    // All three children are bounded — `runGit`, generic `runCommand`, and
    // `sqliteExec`. The generic boundary accepts a caller's explicit finite
    // budget but still defaults to the shared fence; the other two stay fixed.
    expect(e2eCommandHelper.match(/timeout: COMMAND_TIMEOUT_MS/g) ?? []).toHaveLength(2)
    expect(e2eCommandHelper).toContain('timeout: options.timeoutMs ?? COMMAND_TIMEOUT_MS')
    expect(e2eSqliteRunner).toContain("from 'bun:sqlite'")
    // Fixture SQL races the live daemon for the write lock. Behaviour is locked
    // by e2e-sqlite-fixture-lock-contention.test.ts — this only pins that the
    // wait stays inside the parent's command deadline so a wedge is still
    // bounded, across the process boundary that now separates the two.
    expect(e2eSqliteRunner).toContain('PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};')
    expect(
      e2eConstant(e2eSqliteRunner, 'SQLITE_BUSY_TIMEOUT_MS', 'e2e/fixtures/sqlite-exec.ts'),
    ).toBeLessThan(e2eConstant(e2eCommandHelper, 'COMMAND_TIMEOUT_MS', 'e2e/command.ts'))
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
    const expectedCiWorkDeadlines = new Map<string, number>([
      ['lint', 15],
      ['test-backend', 15],
      ['test-backend-postgresql', 15],
      ['test-backend-migration', 15],
      ['test-frontend', 20],
      ['scans', 15],
      ['perf', 15],
      ['docs', 15],
      ['build-binary', 15],
      ['build-binary-macos', 15],
      ['build-binary-windows', 15],
      ['e2e', 20],
      ['e2e-macos', 20],
      ['e2e-windows', 20],
    ])
    const expectedEntryDeadlines = new Map<string, number>([
      ['detect-changes', 5],
      ['docs-fast-gate', 10],
      ['ci-required', 5],
    ])
    expect(workflowJobNames(ciWorkflow)).toEqual([...CI_WORK_JOB_IDS])
    expect([...expectedCiWorkDeadlines.keys()]).toEqual([...CI_WORK_JOB_IDS])
    expect(workflowJobNames(ciEntryWorkflow)).toEqual([
      'detect-changes',
      'docs-fast-gate',
      'full-ci',
      'ci-required',
    ])
    for (const [name, minutes] of expectedCiWorkDeadlines) {
      const job = workflowJob(ciWorkflow, name)
      expect(occurrenceCount(job, 'timeout-minutes:')).toBe(1)
      expect(job).toContain(`timeout-minutes: ${minutes}`)
    }
    for (const [name, minutes] of expectedEntryDeadlines) {
      const job = workflowJob(ciEntryWorkflow, name)
      expect(occurrenceCount(job, 'timeout-minutes:')).toBe(1)
      expect(job).toContain(`timeout-minutes: ${minutes}`)
    }

    const fullNightlyJob = workflowJob(fullBackendNightly, 'test-backend-full')
    expect(workflowJobNames(fullBackendNightly)).toEqual(['test-backend-full'])
    expect(occurrenceCount(fullNightlyJob, 'timeout-minutes:')).toBe(1)
    expect(fullNightlyJob).toContain('timeout-minutes: 15')

    const visualJob = workflowJob(visualWorkflow, 'visual-regression')
    expect(workflowJobNames(visualWorkflow)).toEqual(['visual-regression'])
    expect(occurrenceCount(visualJob, 'timeout-minutes:')).toBe(1)
    expect(visualJob).toContain('timeout-minutes: 20')

    const expectedCrossOsDeadlines = new Map<string, number>([
      ['build-binary-macos', 15],
      ['build-binary-windows', 15],
      ['e2e-macos-full', 25],
      ['e2e-windows-full', 25],
      ['test-frontend-windows', 20],
      ['gitleaks-full-history', 15],
    ])
    expect(workflowJobNames(crossOsE2eNightly)).toEqual([...expectedCrossOsDeadlines.keys()])
    for (const [name, minutes] of expectedCrossOsDeadlines) {
      const job = workflowJob(crossOsE2eNightly, name)
      expect(occurrenceCount(job, 'timeout-minutes:')).toBe(1)
      expect(job).toContain(`timeout-minutes: ${minutes}`)
    }
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
    for (const job of ['build-binary', 'build-binary-macos', 'build-binary-windows']) {
      const source = workflowJob(ciWorkflow, job)
      expect(`${job}: ${source.includes('if: ${{ !cancelled() && inputs.run_e2e }}')}`).toBe(
        `${job}: true`,
      )
    }
    for (const [job, build] of [
      ['e2e', 'build-binary'],
      ['e2e-macos', 'build-binary-macos'],
      ['e2e-windows', 'build-binary-windows'],
    ]) {
      const source = workflowJob(ciWorkflow, job!)
      expect(source).toContain(
        `if: \${{ !cancelled() && inputs.run_e2e && needs.${build}.result == 'success' }}`,
      )
      expect(source).toContain(`needs: ${build}`)
    }
  })

  test('binary build overlaps unit matrices instead of serializing the CI critical path', () => {
    const platformEdges = [
      ['build-binary', 'e2e'],
      ['build-binary-macos', 'e2e-macos'],
      ['build-binary-windows', 'e2e-windows'],
    ] as const

    // Every build consumes only the checkout, so waiting for lint/backend/
    // frontend adds their complete wall time before compilation can even start.
    // Every e2e platform consumes exactly one platform-matched artifact; making
    // it depend on all builds recreates the slowest-build barrier this topology
    // exists to remove.
    for (const [build, e2e] of platformEdges) {
      expect(workflowJob(ciWorkflow, build)).not.toMatch(/^ {4}needs:/m)
      expect(workflowJob(ciWorkflow, e2e)).toContain(`needs: ${build}`)
    }
  })

  test('the stable required context waits for and fails closed on every CI mode and job', () => {
    const requiredJob = workflowJob(ciEntryWorkflow, 'ci-required')
    const expectedNeeds = workflowJobNames(ciWorkflow)
    const entry = parse(ciEntryWorkflow)
    const outputs = parse(ciWorkflow).on.workflow_call.outputs

    expect(requiredJob).toContain('name: CI required')
    expect(requiredJob).toContain('if: ${{ always() }}')
    expect(entry.jobs['ci-required'].needs).toEqual(['detect-changes', 'docs-fast-gate', 'full-ci'])
    expect(Object.keys(outputs)).toEqual(expectedNeeds)
    expect(requiredJob).toContain("DETECT_CHANGES_RESULT: ${{ needs['detect-changes'].result }}")
    expect(requiredJob).toContain("CI_MODE: ${{ needs['detect-changes'].outputs.mode }}")
    expect(requiredJob).toContain("RUN_E2E: ${{ needs['detect-changes'].outputs.run_e2e }}")
    expect(requiredJob).toContain("DOCS_FAST_GATE_RESULT: ${{ needs['docs-fast-gate'].result }}")
    expect(requiredJob).toContain("FULL_CI_RESULT: ${{ needs['full-ci'].result }}")
    expect(requiredJob).toContain('expect_result detect-changes success "$DETECT_CHANGES_RESULT"')
    expect(requiredJob).toContain('expect_result docs-fast-gate success "$DOCS_FAST_GATE_RESULT"')
    expect(requiredJob).toContain('expect_result full-ci skipped "$FULL_CI_RESULT"')
    expect(requiredJob).toContain('expect_result docs-fast-gate skipped "$DOCS_FAST_GATE_RESULT"')
    expect(requiredJob).toContain('expect_result full-ci success "$FULL_CI_RESULT"')

    const conditionallySkippable = new Set([
      'test-backend-migration',
      'build-binary',
      'build-binary-macos',
      'build-binary-windows',
      'e2e',
      'e2e-macos',
      'e2e-windows',
    ])
    for (const dependency of expectedNeeds) {
      const resultEnv = `${dependency.replaceAll('-', '_').toUpperCase()}_RESULT`
      expect(outputs[dependency].value).toBe(
        `\${{ fromJSON(toJSON(jobs['${dependency}'])).result }}`,
      )
      expect(requiredJob).toContain(
        `${resultEnv}: \${{ needs['full-ci'].outputs['${dependency}'] }}`,
      )
      if (conditionallySkippable.has(dependency)) {
        expect(requiredJob).toContain(`expect_result ${dependency} success "$${resultEnv}"`)
        expect(requiredJob).toContain(`expect_result ${dependency} skipped "$${resultEnv}"`)
      } else {
        expect(requiredJob).toContain(`expect_result ${dependency} success "$${resultEnv}"`)
      }
    }
    expect(requiredJob).toContain('if [ "$actual" != "$expected" ]; then')
    expect(requiredJob).toContain("invalid CI_MODE '${CI_MODE:-missing}'")
    expect(requiredJob).toContain("invalid RUN_E2E '${RUN_E2E:-missing}'")
    expect(requiredJob).toContain('exit "$failed"')
  })

  test('OpenCode admission and CI define no version floor or ceiling', () => {
    const opencodeUtil = readFileSync(
      resolve(
        root,
        'packages',
        'backend',
        'src',
        'modules',
        'runtime-management',
        'infrastructure',
        'drivers',
        'opencode',
        'util.ts',
      ),
      'utf8',
    )
    const opencodeDriver = readFileSync(
      resolve(
        root,
        'packages',
        'backend',
        'src',
        'modules',
        'runtime-management',
        'infrastructure',
        'drivers',
        'opencode',
        'driver.ts',
      ),
      'utf8',
    )
    for (const [name, source] of [
      ['opencode.ts', opencodeUtil],
      ['opencode/driver.ts', opencodeDriver],
      [
        'local/opencodeAgentMaterial.ts',
        readFileSync(
          resolve(
            root,
            'packages/backend/src/modules/runtime-management/infrastructure/local/opencodeAgentMaterial.ts',
          ),
          'utf8',
        ),
      ],
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
