// RFC-615: release computation admission before the terminal runner queues,
// while keeping every original gate and source-SHA timing provenance strict.
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse, stringify } from 'yaml'
import {
  CI_WORKFLOW_PATH,
  CI_WORK_JOB_IDS,
  resolveCiWorkSource,
} from '../../../scripts/ci/workflow-source'

const root = resolve(import.meta.dir, '../../..')
const entryPath = '.github/workflows/ci.yml'
const entrySource = readFileSync(resolve(root, entryPath), 'utf8')
const workSource = readFileSync(resolve(root, CI_WORKFLOW_PATH), 'utf8')
const entry = parse(entrySource)
const work = parse(workSource)
const required = entry.jobs['ci-required']
const gate = required.steps[0].run as string
const resultEnv = (id: string) => `${id.replaceAll('-', '_').toUpperCase()}_RESULT`
const success = Object.fromEntries(
  ['full-ci', ...CI_WORK_JOB_IDS].map((id) => [resultEnv(id), 'success']),
)

function executeGate(results: Record<string, string>) {
  return spawnSync('bash', ['-e', '-c', gate], {
    env: { ...process.env, ...results },
    encoding: 'utf8',
    timeout: 5_000,
  })
}

describe('RFC-615 computation admission and terminal gate', () => {
  test('same-commit calculation alone holds admission; the unchanged required context waits outside it', () => {
    expect(Object.keys(entry.jobs)).toEqual(['full-ci', 'ci-required'])
    expect(entry.concurrency).toBeUndefined()
    expect(entry.jobs['full-ci'].uses).toBe(`./${CI_WORKFLOW_PATH}`)
    expect(entry.jobs['full-ci'].concurrency.queue).toBe('max')
    expect(entry.jobs['full-ci'].concurrency['cancel-in-progress']).toBe(false)
    expect(entry.jobs['full-ci']['runs-on']).toBeUndefined()
    expect(entry.jobs['full-ci'].steps).toBeUndefined()
    expect(entry.jobs['full-ci']['continue-on-error']).toBeUndefined()
    expect(Object.keys(work.on)).toEqual(['workflow_call'])
    expect(work.concurrency).toBeUndefined()
    expect(required.name).toBe('CI required')
    expect(required.if).toBe('${{ always() }}')
    expect(required.needs).toEqual(['full-ci'])
    expect(required.concurrency).toBeUndefined()
    expect(required['runs-on']).toBe('ubuntu-slim')
    expect(required['timeout-minutes']).toBe(5)
    expect(required.steps).toHaveLength(1)
    expect(required.steps[0].uses).toBeUndefined()
    expect(required.steps[0].shell).toBe('bash')
  })

  test('all 13 original gate groups, 70 runner jobs and per-job deadlines remain present', () => {
    expect(Object.keys(work.jobs)).toEqual([...CI_WORK_JOB_IDS])
    expect(Object.keys(work.on.workflow_call.outputs)).toEqual([...CI_WORK_JOB_IDS])
    expect(Object.keys(required.env).sort()).toEqual(Object.keys(success).sort())
    let runnerJobs = 1
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
      const matrix = job.strategy?.matrix as Record<string, unknown[]> | undefined
      if (matrix) {
        expect(matrix.include).toBeUndefined()
        expect(matrix.exclude).toBeUndefined()
        expect(job.strategy['fail-fast']).toBe(false)
        runnerJobs += Object.values(matrix).reduce((count, values) => count * values.length, 1)
      } else runnerJobs++
    }
    expect(runnerJobs).toBe(70)
    expect(required.env.FULL_CI_RESULT).toBe("${{ needs['full-ci'].result }}")
  })

  test('the actual required Bash script accepts only complete success', () => {
    const result = executeGate(success)
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
  })

  for (const outcome of ['failure', 'cancelled', 'skipped', '', 'unknown']) {
    test(`the actual required Bash script rejects ${outcome || 'missing'} in every gate and the reusable caller`, () => {
      for (const id of ['full-ci', ...CI_WORK_JOB_IDS]) {
        const result = executeGate({ ...success, [resultEnv(id)]: outcome })
        expect(result.error).toBeUndefined()
        expect(result.status).toBe(1)
        expect(result.stdout).toContain(`${id} concluded '${outcome || 'missing'}'`)
      }
    })
  }

  test('fixture cache is per runner job and is never restored from Actions storage', () => {
    const backend = work.jobs['test-backend']
    const cacheStep = backend.steps.find(
      (step: { name?: string }) => step.name === 'Prepare job-local immutable test fixture cache',
    )
    expect(cacheStep.run).toBe(
      'echo "AW_TEST_FIXTURE_CACHE_DIR=$RUNNER_TEMP/aw-test-fixtures" >> "$GITHUB_ENV"',
    )
    for (const job of Object.values(work.jobs) as {
      steps: { uses?: string; with?: { path?: string } }[]
    }[]) {
      for (const step of job.steps) {
        if (step.uses?.startsWith('actions/cache@')) {
          expect(step.with?.path).not.toContain('aw-test-fixtures')
          expect(step.with?.path).not.toContain('AW_TEST_FIXTURE_CACHE_DIR')
        }
      }
    }
  })
})

describe('RFC-615 timing source workflow resolution', () => {
  test('the no-install collector uses only the pinned runtime and local source modules', () => {
    const source = readFileSync(resolve(root, 'scripts/ci/workflow-source.ts'), 'utf8')
    expect(source).toContain("import { YAML } from 'bun'")
    expect(source).not.toContain("from 'yaml'")
    const collector = parse(readFileSync(resolve(root, '.github/workflows/ci-timings.yml'), 'utf8'))
    const setup = collector.jobs.collect.steps.find(
      (step: { uses?: string }) => step.uses === 'oven-sh/setup-bun@v2',
    )
    expect(setup.with['bun-version']).toBe('1.4.3')
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

  test('reads the exact child path through the same source-SHA callback', () => {
    expect(resolveSource(entrySource)).toEqual({
      result: { path: CI_WORKFLOW_PATH, workflow: workSource },
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
})
