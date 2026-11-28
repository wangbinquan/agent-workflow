// RFC-615 / RFC-627: bounded workflow-level concurrency, tiered verification routing,
// fail-closed terminal gate across all three CI modes, and source-SHA provenance checks.
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse, stringify } from 'yaml'
import {
  BACKEND_FULL_NIGHTLY_PATH,
  CI_WORKFLOW_PATH,
  CI_WORK_JOB_IDS,
  CROSS_OS_NIGHTLY_E2E_JOB_IDS,
  E2E_CROSS_OS_NIGHTLY_PATH,
  LEGACY_CI_WORK_JOB_IDS,
  resolveCiWorkSource,
  resolveCrossOsNightlyE2ESource,
  resolveNightlyBackendSource,
} from '../../../scripts/ci/workflow-source'

const root = resolve(import.meta.dir, '../../..')
const entryPath = '.github/workflows/ci.yml'
const entrySource = readFileSync(resolve(root, entryPath), 'utf8')
const workSource = readFileSync(resolve(root, CI_WORKFLOW_PATH), 'utf8')
const nightlySource = readFileSync(resolve(root, BACKEND_FULL_NIGHTLY_PATH), 'utf8')
const crossOsNightlySource = readFileSync(resolve(root, E2E_CROSS_OS_NIGHTLY_PATH), 'utf8')
const entry = parse(entrySource)
const work = parse(workSource)
const nightly = parse(nightlySource)
const required = entry.jobs['ci-required']
const gate = required.steps[0].run as string
const resultEnv = (id: string) => `${id.replaceAll('-', '_').toUpperCase()}_RESULT`

const E2E_AND_BUILD_JOB_IDS = [
  'build-binary',
  'build-binary-macos',
  'build-binary-windows',
  'e2e',
  'e2e-macos',
  'e2e-windows',
] as const

const allWorkSuccessEnvs = Object.fromEntries(
  CI_WORK_JOB_IDS.map((id) => [resultEnv(id), 'success']),
)
const emptyWorkEnvs = Object.fromEntries(CI_WORK_JOB_IDS.map((id) => [resultEnv(id), '']))
const skippedE2eBuildEnvs = Object.fromEntries(
  E2E_AND_BUILD_JOB_IDS.map((id) => [resultEnv(id), 'skipped']),
)

const docsOnlySuccess: Record<string, string> = {
  DETECT_CHANGES_RESULT: 'success',
  CI_MODE: 'docs-only',
  RUN_E2E: 'false',
  DOCS_FAST_GATE_RESULT: 'success',
  FULL_CI_RESULT: 'skipped',
  ...emptyWorkEnvs,
}

const standardSuccess: Record<string, string> = {
  DETECT_CHANGES_RESULT: 'success',
  CI_MODE: 'standard',
  RUN_E2E: 'true',
  DOCS_FAST_GATE_RESULT: 'skipped',
  FULL_CI_RESULT: 'success',
  ...allWorkSuccessEnvs,
  TEST_BACKEND_MIGRATION_RESULT: 'skipped',
}

const standardNoE2eSuccess: Record<string, string> = {
  ...standardSuccess,
  RUN_E2E: 'false',
  ...skippedE2eBuildEnvs,
}

const fullSuccess: Record<string, string> = {
  DETECT_CHANGES_RESULT: 'success',
  CI_MODE: 'full',
  RUN_E2E: 'true',
  DOCS_FAST_GATE_RESULT: 'skipped',
  FULL_CI_RESULT: 'success',
  ...allWorkSuccessEnvs,
}

const fullNoE2eSuccess: Record<string, string> = {
  ...fullSuccess,
  RUN_E2E: 'false',
  ...skippedE2eBuildEnvs,
}

function executeGate(results: Record<string, string>) {
  return spawnSync('bash', ['-e', '-c', gate], {
    env: { ...process.env, ...results },
    encoding: 'utf8',
    timeout: 5_000,
  })
}

describe('RFC-615 / RFC-627 CI admission, tiering, and terminal gate', () => {
  test('workflow-level concurrency bounds queue depth and ci-required stays fail-closed', () => {
    expect(Object.keys(entry.jobs)).toEqual([
      'detect-changes',
      'docs-fast-gate',
      'full-ci',
      'ci-required',
    ])
    expect(entry.concurrency['cancel-in-progress']).toBe(false)
    expect(entry.concurrency.queue).toBeUndefined()
    expect(entry.jobs['detect-changes']['runs-on']).toBe('ubuntu-latest')
    expect(entry.jobs['detect-changes']['timeout-minutes']).toBe(5)
    expect(entry.jobs['docs-fast-gate'].needs).toEqual(['detect-changes'])
    expect(entry.jobs['docs-fast-gate']['timeout-minutes']).toBe(10)
    expect(entry.jobs['full-ci'].needs).toEqual(['detect-changes'])
    expect(entry.jobs['full-ci'].uses).toBe(`./${CI_WORKFLOW_PATH}`)
    expect(entry.jobs['full-ci'].with).toEqual({
      run_migration_full: "${{ needs['detect-changes'].outputs.mode == 'full' }}",
      links_base_sha: "${{ needs['detect-changes'].outputs.links_base_sha }}",
      run_frontend_full: "${{ needs['detect-changes'].outputs.run_frontend_full != 'false' }}",
      run_e2e: "${{ needs['detect-changes'].outputs.run_e2e != 'false' }}",
      gitleaks_base_sha: "${{ needs['detect-changes'].outputs.gitleaks_base_sha }}",
    })
    expect(entry.jobs['full-ci'].concurrency).toBeUndefined()
    expect(entry.jobs['full-ci']['runs-on']).toBeUndefined()
    expect(entry.jobs['full-ci'].steps).toBeUndefined()
    expect(entry.jobs['full-ci']['continue-on-error']).toBeUndefined()
    expect(Object.keys(work.on)).toEqual(['workflow_call'])
    expect(work.concurrency).toBeUndefined()
    expect(required.name).toBe('CI required')
    expect(required.if).toBe('${{ always() }}')
    expect(required.needs).toEqual(['detect-changes', 'docs-fast-gate', 'full-ci'])
    expect(required.concurrency).toBeUndefined()
    expect(required['runs-on']).toBe('ubuntu-slim')
    expect(required['timeout-minutes']).toBe(5)
    expect(required.steps).toHaveLength(1)
    expect(required.steps[0].uses).toBeUndefined()
    expect(required.steps[0].shell).toBe('bash')
  })

  test('all 14 calculation job groups, exact runner counts and per-job deadlines remain present', () => {
    expect(Object.keys(work.jobs)).toEqual([...CI_WORK_JOB_IDS])
    expect(Object.keys(work.on.workflow_call.outputs)).toEqual([...CI_WORK_JOB_IDS])
    expect(Object.keys(required.env).sort()).toEqual(Object.keys(fullSuccess).sort())

    let standardCalculationJobs = 0
    let fullCalculationJobs = 0
    for (const id of CI_WORK_JOB_IDS) {
      const job = work.jobs[id]
      expect(work.on.workflow_call.outputs[id].value).toBe(
        `\${{ fromJSON(toJSON(jobs['${id}'])).result }}`,
      )
      expect(required.env[resultEnv(id)]).toBe(`\${{ needs['full-ci'].outputs['${id}'] }}`)
      expect(job.concurrency).toBeUndefined()
      expect(job['continue-on-error']).toBeUndefined()
      expect(job['runs-on']).toBeDefined()
      expect(job['timeout-minutes']).toBe(id === 'test-frontend' || id.startsWith('e2e') ? 20 : 15)
      const matrix = job.strategy?.matrix as Record<string, unknown> | undefined
      let count = 1
      if (matrix) {
        expect(matrix.include).toBeUndefined()
        expect(matrix.exclude).toBeUndefined()
        expect(job.strategy['fail-fast']).toBe(false)
        if (id === 'test-frontend') {
          expect(matrix.os).toEqual(['ubuntu-latest'])
          expect(matrix.shard).toBe(
            "${{ fromJSON(inputs.run_frontend_full && '[1, 2, 3]' || '[1]') }}",
          )
          // Full frontend runs 3 Ubuntu shards (backend-only contract fast-path runs 1).
          count = 3
        } else {
          count = Object.values(matrix).reduce<number>((acc, values) => {
            expect(Array.isArray(values), `${id} matrix axis must be an array`).toBe(true)
            return acc * (values as unknown[]).length
          }, 1)
        }
      }
      fullCalculationJobs += count
      if (id !== 'test-backend-migration') standardCalculationJobs += count
    }
    // RFC-629: Standard calculation (max): lint(1) + core backend(12) + PG(1) + frontend(3) +
    // scans(1) + perf(1) + docs(1) + build(3) + e2e(3 Linux + 2 macOS + 2 Windows = 7) = 30.
    // Full adds 28 migration shards = 58.
    expect(standardCalculationJobs).toBe(30)
    expect(fullCalculationJobs).toBe(58)
    expect(required.env.DETECT_CHANGES_RESULT).toBe("${{ needs['detect-changes'].result }}")
    expect(required.env.CI_MODE).toBe("${{ needs['detect-changes'].outputs.mode }}")
    expect(required.env.RUN_E2E).toBe("${{ needs['detect-changes'].outputs.run_e2e }}")
    expect(required.env.DOCS_FAST_GATE_RESULT).toBe("${{ needs['docs-fast-gate'].result }}")
    expect(required.env.FULL_CI_RESULT).toBe("${{ needs['full-ci'].result }}")
  })

  test('the actual required Bash script accepts valid docs-only, standard, and full outcomes (with and without E2E)', () => {
    for (const [label, env] of [
      ['docs-only', docsOnlySuccess],
      ['standard', standardSuccess],
      ['standard (run_e2e=false)', standardNoE2eSuccess],
      ['full', fullSuccess],
      ['full (run_e2e=false)', fullNoE2eSuccess],
    ] as const) {
      const result = executeGate(env)
      expect(result.error, label).toBeUndefined()
      expect(result.status, `${label}: ${result.stdout}${result.stderr}`).toBe(0)
    }
  })

  test('the actual required Bash script enforces orthogonal RUN_E2E checks and rejects invalid values', () => {
    for (const base of [standardSuccess, fullSuccess]) {
      for (const badRunE2e of ['', 'yes', 'TRUE', '1', 'auto']) {
        const result = executeGate({ ...base, RUN_E2E: badRunE2e })
        expect(result.status).toBe(1)
        expect(result.stdout).toContain(`invalid RUN_E2E '${badRunE2e || 'missing'}'`)
      }
    }
    for (const base of [standardNoE2eSuccess, fullNoE2eSuccess]) {
      for (const id of E2E_AND_BUILD_JOB_IDS) {
        for (const badOutcome of ['success', 'failure', 'cancelled', '', 'unknown']) {
          const result = executeGate({ ...base, [resultEnv(id)]: badOutcome })
          expect(result.status).toBe(1)
          expect(result.stdout).toContain(
            `${id} concluded '${badOutcome || 'missing'}', expected 'skipped'`,
          )
        }
      }
    }
  })

  test('the actual required Bash script rejects invalid or missing CI_MODE and failed detect-changes', () => {
    for (const mode of ['', 'unknown', 'docs', 'fast', 'FULL']) {
      const result = executeGate({ ...fullSuccess, CI_MODE: mode })
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(1)
      expect(result.stdout).toContain(`invalid CI_MODE '${mode || 'missing'}'`)
    }
    for (const base of [docsOnlySuccess, standardSuccess, fullSuccess]) {
      for (const outcome of ['failure', 'cancelled', 'skipped', '', 'unknown']) {
        const result = executeGate({ ...base, DETECT_CHANGES_RESULT: outcome })
        expect(result.error).toBeUndefined()
        expect(result.status).toBe(1)
        expect(result.stdout).toContain(
          `detect-changes concluded '${outcome || 'missing'}', expected 'success'`,
        )
      }
    }
  })

  test('the actual required Bash script fails closed in docs-only when fast gate fails or full-ci was not skipped', () => {
    for (const outcome of ['failure', 'cancelled', 'skipped', '', 'unknown']) {
      const result = executeGate({ ...docsOnlySuccess, DOCS_FAST_GATE_RESULT: outcome })
      expect(result.status).toBe(1)
      expect(result.stdout).toContain(
        `docs-fast-gate concluded '${outcome || 'missing'}', expected 'success'`,
      )
    }
    for (const outcome of ['success', 'failure', 'cancelled', '', 'unknown']) {
      const result = executeGate({ ...docsOnlySuccess, FULL_CI_RESULT: outcome })
      expect(result.status).toBe(1)
      expect(result.stdout).toContain(
        `full-ci concluded '${outcome || 'missing'}', expected 'skipped'`,
      )
    }
  })

  for (const outcome of ['failure', 'cancelled', 'skipped', '', 'unknown']) {
    test(`the actual required Bash script rejects ${outcome || 'missing'} in every full-mode gate`, () => {
      for (const id of ['full-ci', ...CI_WORK_JOB_IDS]) {
        const result = executeGate({ ...fullSuccess, [resultEnv(id)]: outcome })
        expect(result.error).toBeUndefined()
        expect(result.status).toBe(1)
        expect(result.stdout).toContain(
          `${id} concluded '${outcome || 'missing'}', expected 'success'`,
        )
      }
    })
  }

  test('the actual required Bash script enforces exact standard-mode expectations (migration skipped, docs-fast-gate skipped)', () => {
    for (const badMigration of ['success', 'failure', 'cancelled', '', 'unknown']) {
      const result = executeGate({
        ...standardSuccess,
        TEST_BACKEND_MIGRATION_RESULT: badMigration,
      })
      expect(result.status).toBe(1)
      expect(result.stdout).toContain(
        `test-backend-migration concluded '${badMigration || 'missing'}', expected 'skipped'`,
      )
    }
    for (const base of [standardSuccess, fullSuccess]) {
      for (const badDocsGate of ['success', 'failure', 'cancelled', '', 'unknown']) {
        const result = executeGate({ ...base, DOCS_FAST_GATE_RESULT: badDocsGate })
        expect(result.status).toBe(1)
        expect(result.stdout).toContain(
          `docs-fast-gate concluded '${badDocsGate || 'missing'}', expected 'skipped'`,
        )
      }
    }
    for (const id of CI_WORK_JOB_IDS.filter((jobId) => jobId !== 'test-backend-migration')) {
      const result = executeGate({ ...standardSuccess, [resultEnv(id)]: 'skipped' })
      expect(result.status).toBe(1)
      expect(result.stdout).toContain(`${id} concluded 'skipped', expected 'success'`)
    }
  })

  test('fixture cache is per runner job and is never restored from Actions storage', () => {
    for (const job of [
      work.jobs['test-backend'],
      work.jobs['test-backend-postgresql'],
      work.jobs['test-backend-migration'],
      nightly.jobs['test-backend-full'],
    ]) {
      const cacheStep = job.steps.find(
        (step: { name?: string }) => step.name === 'Prepare job-local immutable test fixture cache',
      )
      expect(cacheStep.run).toBe(
        'echo "AW_TEST_FIXTURE_CACHE_DIR=$RUNNER_TEMP/aw-test-fixtures" >> "$GITHUB_ENV"',
      )
    }
    for (const job of [
      ...(Object.values(work.jobs) as { steps: { uses?: string; with?: { path?: string } }[] }[]),
      nightly.jobs['test-backend-full'] as {
        steps: { uses?: string; with?: { path?: string } }[]
      },
    ]) {
      for (const step of job.steps) {
        if (step.uses?.startsWith('actions/cache@')) {
          expect(step.with?.path).not.toContain('aw-test-fixtures')
          expect(step.with?.path).not.toContain('AW_TEST_FIXTURE_CACHE_DIR')
        }
      }
    }
  })
})

describe('RFC-615 / RFC-627 no-install CI scripts and timing workflow resolution', () => {
  test('all no-install CI scripts import only Bun builtins, node:* builtins, and local sibling modules', () => {
    const noInstallScripts = [
      'scripts/ci/workflow-source.ts',
      'scripts/ci/backend-shards.ts',
      'scripts/ci/e2e-shards.ts',
      'scripts/ci/classify-ci-changes.ts',
      'scripts/ci/refresh-backend-timings.ts',
      'scripts/ci/compose-backend-timings.ts',
      'scripts/ci/refresh-e2e-timings.ts',
      'scripts/ci/run-postgresql-gate.ts',
      'scripts/ci/run-frontend-contract-tests.ts',
    ]
    for (const relPath of noInstallScripts) {
      const source = readFileSync(resolve(root, relPath), 'utf8')
      const imports = [...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!)
      for (const specifier of imports) {
        const allowed =
          specifier === 'bun' || specifier.startsWith('node:') || specifier.startsWith('./')
        expect(allowed, `${relPath} imports third-party package '${specifier}'`).toBe(true)
      }
      expect(source, relPath).not.toContain("from 'yaml'")
    }
    expect(readFileSync(resolve(root, 'scripts/ci/workflow-source.ts'), 'utf8')).toContain(
      "import { YAML } from 'bun'",
    )
    const collector = parse(readFileSync(resolve(root, '.github/workflows/ci-timings.yml'), 'utf8'))
    const collectorBun = collector.jobs.collect.steps.find(
      (step: { uses?: string }) => step.uses === 'oven-sh/setup-bun@v2',
    )
    expect(collectorBun.with['bun-version']).toBe('1.4.3')
    const detectBun = entry.jobs['detect-changes'].steps.find(
      (step: { uses?: string }) => step.uses === 'oven-sh/setup-bun@v2',
    )
    expect(detectBun.with['bun-version']).toBe('1.4.3')
  })

  function resolveSource(parent: string, child = workSource) {
    const requested: string[] = []
    const result = resolveCiWorkSource((path) => {
      requested.push(path)
      if (path === entryPath) return parent
      if (path === CI_WORKFLOW_PATH) return child
      throw new Error(`Unexpected source path: ${path}`)
    })
    return { result, requested }
  }

  test('reads the exact child path through the same source-SHA callback for 14-job current and 13-job legacy ci-work', () => {
    expect(resolveSource(entrySource)).toEqual({
      result: { path: CI_WORKFLOW_PATH, workflow: workSource },
      requested: [entryPath, CI_WORKFLOW_PATH],
    })
    const legacyJobs = Object.fromEntries(LEGACY_CI_WORK_JOB_IDS.map((id) => [id, {}]))
    const legacyWork = stringify({ on: { workflow_call: {} }, jobs: legacyJobs })
    expect(resolveSource(entrySource, legacyWork)).toEqual({
      result: { path: CI_WORKFLOW_PATH, workflow: legacyWork },
      requested: [entryPath, CI_WORKFLOW_PATH],
    })
  })

  test('historical monolithic runs require no child that did not exist at that commit', () => {
    const historical = stringify({
      name: 'CI',
      on: { push: { branches: ['main'] } },
      jobs: work.jobs,
    })
    expect(resolveSource(historical, 'must not read')).toEqual({
      result: { path: entryPath, workflow: historical },
      requested: [entryPath],
    })
  })

  test('rejects mixed, remote, renamed and absent calculation sources', () => {
    expect(() =>
      resolveSource(stringify({ ...entry, jobs: { ...entry.jobs, 'test-backend': {} } })),
    ).toThrow('Mixed')
    for (const uses of [
      'owner/repo/.github/workflows/ci-work.yml@main',
      './.github/workflows/other.yml',
      undefined,
    ]) {
      expect(() => resolveSource(stringify({ ...entry, jobs: { 'full-ci': { uses } } }))).toThrow(
        'Unknown source',
      )
    }
    expect(() => resolveSource('name: CI\njobs: {}')).toThrow('Unknown source')
    expect(() =>
      resolveCiWorkSource((path) => {
        if (path === entryPath) return entrySource
        throw new Error('absent at source commit')
      }),
    ).toThrow('absent at source commit')
  })

  test('rejects extra triggers and missing or unrelated source job groups', () => {
    for (const on of [
      { push: {} },
      { workflow_call: {}, push: {} },
      { workflow_call: {}, repository_dispatch: {} },
    ]) {
      expect(() => resolveSource(entrySource, stringify({ ...work, on }))).toThrow('reusable only')
    }
    const missing = { ...work.jobs }
    delete missing['test-backend']
    for (const jobs of [missing, { ...work.jobs, unexpected: {} }]) {
      expect(() => resolveSource(entrySource, stringify({ ...work, jobs }))).toThrow(
        'unknown job population',
      )
    }
  })

  test('resolves backend-full-nightly.yml and rejects missing triggers or unknown job populations', () => {
    expect(
      resolveNightlyBackendSource((path) => {
        if (path !== BACKEND_FULL_NIGHTLY_PATH) throw new Error(`Unexpected path: ${path}`)
        return nightlySource
      }),
    ).toEqual({ path: BACKEND_FULL_NIGHTLY_PATH, workflow: nightlySource })

    for (const bad of [
      stringify({ on: { schedule: [] }, jobs: { 'test-backend-full': {} } }),
      stringify({ on: { workflow_dispatch: {} }, jobs: { 'test-backend-full': {} } }),
      stringify({
        on: { schedule: [], workflow_dispatch: {} },
        jobs: { 'test-backend': {} },
      }),
      stringify({
        on: { schedule: [], workflow_dispatch: {} },
        jobs: { 'test-backend-full': {}, extra: {} },
      }),
    ]) {
      expect(() => resolveNightlyBackendSource(() => bad)).toThrow()
    }
  })

  test('resolves e2e-cross-os-nightly.yml and rejects missing triggers or unknown job populations', () => {
    expect(
      resolveCrossOsNightlyE2ESource((path) => {
        if (path !== E2E_CROSS_OS_NIGHTLY_PATH) throw new Error(`Unexpected path: ${path}`)
        return crossOsNightlySource
      }),
    ).toEqual({ path: E2E_CROSS_OS_NIGHTLY_PATH, workflow: crossOsNightlySource })

    const validJobs = Object.fromEntries(CROSS_OS_NIGHTLY_E2E_JOB_IDS.map((id) => [id, {}]))
    const missingOne = { ...validJobs }
    delete missingOne['e2e-windows-full']
    for (const bad of [
      stringify({ on: { schedule: [] }, jobs: validJobs }),
      stringify({ on: { workflow_dispatch: {} }, jobs: validJobs }),
      stringify({ on: { schedule: [], workflow_dispatch: {} }, jobs: missingOne }),
      stringify({
        on: { schedule: [], workflow_dispatch: {} },
        jobs: { ...validJobs, unexpected: {} },
      }),
    ]) {
      expect(() => resolveCrossOsNightlyE2ESource(() => bad)).toThrow()
    }
  })
})
