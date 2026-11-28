// RFC-611/623: complete evidence must match the source SHA's approved topology;
// missing legacy shards must never masquerade as a smaller current population.
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertCrossOsNightlyE2ETopology,
  assertE2EShardTopology,
  CROSS_OS_NIGHTLY_E2E_SHARD_COUNTS,
  E2E_SHARD_COUNTS,
  IneligibleE2ETimingSampleError,
  mergeE2ETimings,
  parseRefreshE2ETimingsArgs,
  writeE2ETimingReview,
  type E2ETimingArtifact,
  type E2ETimingSource,
  type E2EShardTopology,
} from '../../../scripts/ci/refresh-e2e-timings'
import {
  OS_CORE_E2E_SPECS,
  planE2EShards,
  selectedE2ETests,
  type DiscoveredE2ETest,
  type E2EPlatform,
  type E2ETier,
  type E2ETimings,
} from '../../../scripts/ci/e2e-shards'
import { E2ETimingCollector } from '../../../scripts/ci/e2e-timings-reporter'
import {
  CI_WORKFLOW_PATH,
  CI_WORK_JOB_IDS,
  LEGACY_CI_WORK_JOB_IDS,
  resolveCiWorkSource,
} from '../../../scripts/ci/workflow-source'
import {
  assertSuccessfulTimingSource,
  CROSS_OS_NIGHTLY_E2E_TIMING_SOURCES,
  E2E_CI_TIMING_SOURCES,
} from '../../../scripts/ci/refresh-backend-timings'

const sourceMetadata = {
  runId: 12345,
  sourceSha: 'a'.repeat(40),
  finalAttempt: 2,
  repository: 'owner/repo',
}

function retriedFixture(source: E2ETimingSource) {
  const artifacts = fixture(source)
  const timing = artifacts[0]!.timings
  const file = timing.tests[0]!.file
  const tests = timing.tests.filter((test) => test.file === file)
  // Serial retries also rerun earlier passes and tests skipped after a group failure.
  for (const [index, test] of tests.entries())
    test.results = [
      { status: index === 0 ? 'failed' : 'skipped', retry: 0 },
      { status: 'passed', retry: 1 },
    ]
  timing.files[file]!.attempts += tests.length
  timing.files[file]!.clean = false
  return artifacts
}
function fixture(source: E2ETimingSource) {
  const tests = ['a', 'a', 'b', 'c', 'd', 'skip'].map((name, index) => ({
    id: `test-${index}`,
    file: `e2e/${name}.spec.ts`,
    expectedStatus: name === 'skip' ? 'skipped' : 'passed',
  }))
  return (Object.entries(source.shardCounts) as [E2EPlatform, number][]).flatMap(
    ([platform, total]) => {
      const runner = platform === 'linux' ? 'Linux' : platform === 'macos' ? 'macOS' : 'Windows'
      return Array.from({ length: total }, (_, index) => {
        const plan = planE2EShards(
          tests,
          { version: 1, defaultMs: 60_000, platforms: { linux: {}, macos: {}, windows: {} } },
          platform,
          index + 1,
          total,
          source.sourceSha,
        )
        const collector = new E2ETimingCollector(selectedE2ETests(plan))
        let now = 0
        for (const test of selectedE2ETests(plan)) {
          collector.begin(test.id, now)
          now += test.expectedStatus === 'skipped' ? 1 : 100
          collector.end(test.id, test.expectedStatus, 0, now)
        }
        return {
          name: `e2e-test-timings-${runner}-${index + 1}`,
          plan,
          timings: {
            version: 1,
            measurement: 'first-test-begin-to-last-test-end-per-spec',
            sourceSha: source.sourceSha,
            runId: String(source.runId),
            runAttempt: '1',
            platform,
            shard: plan.shard,
            discoveryDigest: plan.discoveryDigest,
            status: 'passed',
            ...collector.snapshot(),
          },
        }
      })
    },
  )
}

const topologies: readonly Readonly<{ linux: 3; macos: 3 | 4; windows: 4 }>[] = [
  { linux: 3, macos: 3, windows: 4 },
  { linux: 3, macos: 4, windows: 4 },
]

for (const shardCounts of topologies) {
  const source: E2ETimingSource = { ...sourceMetadata, shardCounts }
  describe(`complete E2E timing refresh (${Object.values(shardCounts).join('/')})`, () => {
    test('all source shards replace weights; skipped files remain; previous successful attempts remain valid', () => {
      const artifacts = fixture(source)
      artifacts[1]!.timings.runAttempt = '2'
      const merged = mergeE2ETimings(artifacts, source)
      expect(merged.version).toBe(1)
      expect(merged.defaultMs).toBe(60_000)
      expect(merged.provenance.sourceShardCounts).toEqual(shardCounts)
      expect(merged.provenance.sourceShardCounts).not.toBe(source.shardCounts)
      for (const platform of ['linux', 'macos', 'windows'] as const) {
        expect(Object.keys(merged.platforms[platform])).toEqual(
          ['a', 'b', 'c', 'd', 'skip'].map((name) => `e2e/${name}.spec.ts`),
        )
        expect(merged.platforms[platform]['e2e/a.spec.ts']).toBe(200)
        expect(merged.platforms[platform]['e2e/skip.spec.ts']).toBe(1)
      }
      expect(merged.provenance.shardAttempts[artifacts[0]!.name]).toBe(1)
      expect(merged.provenance.shardAttempts[artifacts[1]!.name]).toBe(2)
      expect(mergeE2ETimings([...artifacts].reverse(), source)).toEqual(merged)
    })
    test('missing/duplicate shards and unsupported artifact names cannot produce a partial refresh', () => {
      const artifacts = fixture(source)
      expect(() => mergeE2ETimings(artifacts.slice(1), source)).toThrow(
        String(Object.values(shardCounts).reduce<number>((sum, count) => sum + count, 0)),
      )
      expect(() => mergeE2ETimings([artifacts[0]!, ...artifacts.slice(0, -1)], source)).toThrow(
        'Duplicate',
      )
      artifacts[0]!.name = 'e2e-test-timings-Solaris-1'
      expect(() => mergeE2ETimings(artifacts, source)).toThrow('name')
    })
    test('plan source/platform/shard and per-platform whole-population agreement are mandatory', () => {
      for (const mutation of ['sha', 'platform', 'shard', 'assignments']) {
        const artifacts = fixture(source)
        const plan = artifacts[1]!.plan
        if (mutation === 'sha') plan.sourceSha = 'b'.repeat(40)
        if (mutation === 'platform') plan.platform = 'windows'
        if (mutation === 'shard') plan.shard.current = 3
        if (mutation === 'assignments')
          [plan.assignments[0], plan.assignments[1]] = [plan.assignments[1]!, plan.assignments[0]!]
        expect(() => mergeE2ETimings(artifacts, source)).toThrow()
      }
    })
    test('foreign runs, future attempts, changed discovery and unsuccessful evidence are refused', () => {
      for (const [field, value] of [
        ['sourceSha', 'b'.repeat(40)],
        ['runId', '999'],
        ['runAttempt', '3'],
        ['runAttempt', '0'],
        ['platform', 'windows'],
        ['discoveryDigest', 'changed'],
        ['status', 'failed'],
        ['complete', false],
        ['measurement', 'summed-test-bodies'],
        ['version', 2],
      ] as const) {
        const artifacts = fixture(source)
        Object.assign(artifacts[0]!.timings, { [field]: value })
        expect(() => mergeE2ETimings(artifacts, source)).toThrow('evidence')
      }
    })
    test('each native test identity must have exactly one clean expected result', () => {
      for (const mutation of [
        'missing',
        'duplicate',
        'foreign',
        'failed',
        'retry',
        'extra-result',
      ]) {
        const artifacts = fixture(source)
        const timing = artifacts[0]!.timings
        if (mutation === 'missing') timing.tests.pop()
        if (mutation === 'duplicate') timing.tests[1] = timing.tests[0]!
        if (mutation === 'foreign') timing.tests[0]!.id = 'foreign'
        if (mutation === 'failed') timing.tests[0]!.results[0]!.status = 'failed'
        if (mutation === 'retry') timing.tests[0]!.results[0]!.retry = 1
        if (mutation === 'extra-result')
          timing.tests[0]!.results.push({ status: 'passed', retry: 1 })
        expect(() => mergeE2ETimings(artifacts, source)).toThrow()
      }
    })
    test('every assigned file needs positive complete, clean, unretried measurement', () => {
      for (const mutation of [
        'missing',
        'foreign',
        'partial',
        'dirty',
        'zero',
        'negative',
        'infinite',
        'attempts',
        'skipped',
      ]) {
        const artifacts = fixture(source)
        const timing = artifacts[0]!.timings
        const file = Object.keys(timing.files)[0]!
        const evidence = timing.files[file]!
        if (mutation === 'missing') delete timing.files[file]
        if (mutation === 'foreign') timing.files['e2e/foreign.spec.ts'] = evidence
        if (mutation === 'partial') evidence.complete = false
        if (mutation === 'dirty') evidence.clean = false
        if (mutation === 'zero') evidence.durationMs = 0
        if (mutation === 'negative') evidence.durationMs = -1
        if (mutation === 'infinite') evidence.durationMs = Infinity
        if (mutation === 'attempts') evidence.attempts++
        if (mutation === 'skipped') evidence.runnable = !evidence.runnable
        expect(() => mergeE2ETimings(artifacts, source)).toThrow()
      }
    })
    test('source and fallback metadata must be valid', () => {
      const artifacts: E2ETimingArtifact[] = fixture(source)
      expect(() => mergeE2ETimings(artifacts, { ...source, sourceSha: 'short' })).toThrow('source')
      expect(() => mergeE2ETimings(artifacts, { ...source, finalAttempt: 0 })).toThrow('source')
      expect(() => mergeE2ETimings(artifacts, source, 0)).toThrow('positive')
    })
    test('the source topology is mandatory and validated at the merge boundary', () => {
      const artifacts = fixture(source)
      for (const value of [
        undefined,
        null,
        [],
        [3, 3, 4],
        '3/3/4',
        334,
        {},
        { linux: 3, macos: 3 },
        { linux: 3, macos: 3, windows: 4, other: 1 },
        { linux: '3', macos: 3, windows: 4 },
        { linux: 3, macos: '3', windows: 4 },
        { linux: 3, macos: true, windows: 4 },
        { linux: 3, macos: 0, windows: 4 },
        { linux: 3, macos: 2, windows: 4 },
        { linux: 3, macos: 5, windows: 4 },
        { linux: 3, macos: NaN, windows: 4 },
        { linux: 3, macos: Infinity, windows: 4 },
        { linux: 4, macos: 3, windows: 4 },
        { linux: 3, macos: 3, windows: 3 },
      ])
        expect(() =>
          mergeE2ETimings(artifacts, { ...source, shardCounts: value as E2EShardTopology }),
        ).toThrow()
    })
    test('macOS plan and timing denominators must match the declared source, not just artifact names', () => {
      const otherSource: E2ETimingSource = {
        ...source,
        shardCounts: { ...shardCounts, macos: shardCounts.macos === 3 ? 4 : 3 },
      }
      const foreignShard = fixture(otherSource).find(
        (artifact) => artifact.name === 'e2e-test-timings-macOS-1',
      )!
      const artifacts = fixture(source)
      const index = artifacts.findIndex((artifact) => artifact.name === foreignShard.name)
      artifacts[index] = foreignShard
      expect(() => mergeE2ETimings(artifacts, source)).toThrow('source/platform/tier/shard')

      const wrongTiming = fixture(source)
      wrongTiming[index]!.timings.shard = {
        ...wrongTiming[index]!.timings.shard,
        total: otherSource.shardCounts.macos,
      }
      expect(() => mergeE2ETimings(wrongTiming, source)).toThrow('evidence')
    })
    test('complete passed serial retries are ineligible weights, with an explicit file reason', () => {
      const artifacts = retriedFixture(source)
      expect(() => mergeE2ETimings(artifacts, source)).toThrow(IneligibleE2ETimingSampleError)
      try {
        mergeE2ETimings(artifacts, source)
      } catch (error) {
        expect(error).toBeInstanceOf(IneligibleE2ETimingSampleError)
        expect((error as IneligibleE2ETimingSampleError).retriedFiles).toEqual([
          `linux/${artifacts[0]!.timings.tests[0]!.file}`,
        ])
      }
      // Previously passing serial siblings may also be rerun after another test fails.
      artifacts[0]!.timings.tests[0]!.results[0]!.status = 'passed'
      expect(() => mergeE2ETimings(artifacts, source)).toThrow(IneligibleE2ETimingSampleError)
      artifacts[0]!.timings.tests[0]!.results[1]!.status = 'failed'
      expect(() => mergeE2ETimings(artifacts, source)).toThrow(IneligibleE2ETimingSampleError)
    })
    test('retries cannot mask malformed sequences, metadata or a later foreign/incomplete shard', () => {
      for (const mutation of [
        'gap',
        'unknown-status',
        'interrupted',
        'final-failure',
        'failed-skipped',
        'clean',
        'attempts',
        'foreign',
        'partial',
      ]) {
        const artifacts = retriedFixture(source)
        const timing = artifacts[0]!.timings
        if (mutation === 'gap') timing.tests[0]!.results[1]!.retry = 2
        if (mutation === 'unknown-status') timing.tests[0]!.results[0]!.status = 'unknown'
        if (mutation === 'interrupted') timing.tests[0]!.results[0]!.status = 'interrupted'
        if (mutation === 'final-failure') timing.tests[0]!.results[1]!.status = 'failed'
        if (mutation === 'failed-skipped') timing.tests[0]!.results[1]!.status = 'skipped'
        if (mutation === 'clean') timing.files[timing.tests[0]!.file]!.clean = true
        if (mutation === 'attempts') timing.files[timing.tests[0]!.file]!.attempts++
        if (mutation === 'foreign') artifacts.at(-1)!.timings.sourceSha = 'b'.repeat(40)
        if (mutation === 'partial') artifacts.at(-1)!.timings.tests.pop()
        for (const ordered of [artifacts, [...artifacts].reverse()]) {
          let failure: unknown
          try {
            mergeE2ETimings(ordered, source)
          } catch (error) {
            failure = error
          }
          expect(failure).toBeInstanceOf(Error)
          expect(failure).not.toBeInstanceOf(IneligibleE2ETimingSampleError)
        }
      }
    })
    test('the review writer records a neutral skip without emitting retry-contaminated weights', () => {
      const directory = mkdtempSync(join(tmpdir(), 'e2e-timing-review-'))
      const output = join(directory, 'weights.json')
      try {
        expect(writeE2ETimingReview(retriedFixture(source), source, output)).toBe('skipped')
        expect(existsSync(output)).toBe(false)
        expect(JSON.parse(readFileSync(`${output}.status.json`, 'utf8'))).toMatchObject({
          status: 'skipped',
          reason: 'retried-tests',
          source,
        })
        expect(writeE2ETimingReview(fixture(source), source, output)).toBe('updated')
        expect(JSON.parse(readFileSync(output, 'utf8')).platforms.linux['e2e/a.spec.ts']).toBe(200)
        expect(JSON.parse(readFileSync(output, 'utf8')).provenance.sourceShardCounts).toEqual(
          shardCounts,
        )
        expect(JSON.parse(readFileSync(`${output}.status.json`, 'utf8')).status).toBe('updated')
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    })
    test('corruption still fails the review writer, and skipped sources cannot reuse stale weights', () => {
      const directory = mkdtempSync(join(tmpdir(), 'e2e-timing-review-'))
      const output = join(directory, 'weights.json')
      try {
        const artifacts = retriedFixture(source)
        artifacts.at(-1)!.timings.complete = false
        expect(() => writeE2ETimingReview(artifacts, source, output)).toThrow('evidence')
        expect(existsSync(output)).toBe(false)
        expect(existsSync(`${output}.status.json`)).toBe(false)
        writeFileSync(output, 'previous weights')
        expect(() => writeE2ETimingReview(retriedFixture(source), source, output)).toThrow('stale')
        expect(readFileSync(output, 'utf8')).toBe('previous weights')
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    })
  })
}

describe('source topology authority', () => {
  test('a historical fourth macOS shard cannot be omitted or reinterpreted as the new topology', () => {
    const legacySource: E2ETimingSource = {
      ...sourceMetadata,
      shardCounts: { linux: 3, macos: 4, windows: 4 },
    }
    const threeMacosSource: E2ETimingSource = {
      ...sourceMetadata,
      shardCounts: { linux: 3, macos: 3, windows: 4 },
    }
    const partialLegacy = fixture(legacySource).filter(
      (artifact) => artifact.name !== 'e2e-test-timings-macOS-4',
    )
    expect(partialLegacy).toHaveLength(10)
    expect(() => mergeE2ETimings(partialLegacy, legacySource)).toThrow('11')
    expect(() => mergeE2ETimings(partialLegacy, threeMacosSource)).toThrow(
      'source/platform/tier/shard',
    )
    expect(() => mergeE2ETimings(fixture(threeMacosSource), legacySource)).toThrow('11')
    expect(() => mergeE2ETimings(fixture(legacySource), threeMacosSource)).toThrow('10')
  })

  test('current source YAML declares the current topology', () => {
    const workflow = readFileSync(
      new URL('../../../.github/workflows/ci-work.yml', import.meta.url),
      'utf8',
    )
    expect(assertE2EShardTopology(workflow)).toEqual(E2E_SHARD_COUNTS)
  })

  for (const shardCounts of topologies) {
    const label = Object.values(shardCounts).join('/')
    test(`${label} is accepted from both historical monolithic and reusable source workflows`, () => {
      const legacy = JSON.stringify({
        jobs: { 'test-backend': {}, ...workflowFixture(shardCounts).jobs },
      })
      const legacyReads: string[] = []
      const legacySource = resolveCiWorkSource((path) => {
        legacyReads.push(path)
        if (path !== '.github/workflows/ci.yml') throw new Error('Unexpected source file')
        return legacy
      })
      expect(legacyReads).toEqual(['.github/workflows/ci.yml'])
      expect(assertE2EShardTopology(legacySource.workflow)).toEqual(shardCounts)

      const reusable = JSON.stringify({
        on: { workflow_call: {} },
        jobs: {
          ...Object.fromEntries(CI_WORK_JOB_IDS.map((id) => [id, {}])),
          ...workflowFixture(shardCounts).jobs,
        },
      })
      const reusableReads: string[] = []
      const reusableSource = resolveCiWorkSource((path) => {
        reusableReads.push(path)
        if (path === '.github/workflows/ci.yml')
          return JSON.stringify({ jobs: { 'full-ci': { uses: `./${CI_WORKFLOW_PATH}` } } })
        if (path === CI_WORKFLOW_PATH) return reusable
        throw new Error('Unexpected source file')
      })
      expect(reusableReads).toEqual(['.github/workflows/ci.yml', CI_WORKFLOW_PATH])
      expect(assertE2EShardTopology(reusableSource.workflow)).toEqual(shardCounts)

      // RFC-627: historical 13-job reusable ci-work.yml commits remain readable for provenance.
      const legacyReusable = JSON.stringify({
        on: { workflow_call: {} },
        jobs: {
          ...Object.fromEntries(LEGACY_CI_WORK_JOB_IDS.map((id) => [id, {}])),
          ...workflowFixture(shardCounts).jobs,
        },
      })
      const legacyReusableSource = resolveCiWorkSource((path) => {
        if (path === '.github/workflows/ci.yml')
          return JSON.stringify({ jobs: { 'full-ci': { uses: `./${CI_WORKFLOW_PATH}` } } })
        if (path === CI_WORKFLOW_PATH) return legacyReusable
        throw new Error('Unexpected source file')
      })
      expect(assertE2EShardTopology(legacyReusableSource.workflow)).toEqual(shardCounts)
    })

    test(`${label} E2E timing source allowlist accepts CI push/workflow_dispatch and rejects nightly/schedule`, () => {
      const baseRun = {
        id: sourceMetadata.runId,
        name: 'CI',
        status: 'completed',
        conclusion: 'success',
        event: 'push',
        head_branch: 'main',
        head_sha: sourceMetadata.sourceSha,
        head_repository: { full_name: sourceMetadata.repository },
      }
      expect(
        assertSuccessfulTimingSource(
          baseRun,
          sourceMetadata.repository,
          sourceMetadata.runId,
          E2E_CI_TIMING_SOURCES,
        ),
      ).toBe(sourceMetadata.sourceSha)
      expect(
        assertSuccessfulTimingSource(
          { ...baseRun, event: 'workflow_dispatch' },
          sourceMetadata.repository,
          sourceMetadata.runId,
          E2E_CI_TIMING_SOURCES,
        ),
      ).toBe(sourceMetadata.sourceSha)
      for (const bad of [
        { name: 'backend-full-nightly', event: 'schedule' },
        { name: 'backend-full-nightly', event: 'workflow_dispatch' },
        { name: 'CI', event: 'schedule' },
        { name: 'CI', event: 'pull_request' },
      ]) {
        expect(() =>
          assertSuccessfulTimingSource(
            { ...baseRun, ...bad },
            sourceMetadata.repository,
            sourceMetadata.runId,
            E2E_CI_TIMING_SOURCES,
          ),
        ).toThrow('successful complete')
      }
    })

    test(`${label} rejects matrix additions, omissions, unsupported counts and input types`, () => {
      const mutations: ((workflow: ReturnType<typeof workflowFixture>) => void)[] = [
        (workflow) => {
          delete workflow.jobs['e2e-macos']
        },
        (workflow) => {
          Object.assign(workflow.jobs, { 'e2e-macos': null })
        },
        (workflow) => {
          Object.assign(workflow.jobs, { 'e2e-macos': [] })
        },
        (workflow) => {
          Object.assign(workflow.jobs['e2e-macos']!, { strategy: null })
        },
        (workflow) => {
          Object.assign(workflow.jobs['e2e-macos']!, { strategy: [] })
        },
        ...[null, [], '${{ fromJSON(needs.plan.outputs.matrix) }}'].map(
          (matrix) => (workflow: ReturnType<typeof workflowFixture>) => {
            Object.assign(workflow.jobs['e2e-macos']!.strategy, { matrix })
          },
        ),
        ...[
          ['include', []],
          ['include', [{ os: 'macos-latest', shard: 4, shards: 4 }]],
          ['exclude', []],
          ['exclude', [{ shard: 3 }]],
          ['extraAxis', ['unaccounted']],
          ['os', null],
          ['os', 'macos-latest'],
          ['os', ['macos-15-intel']],
          ['os', ['macos-latest', 'macos-latest']],
          ['os', ['${{ matrix.runner }}']],
          ['shards', null],
          ['shards', shardCounts.macos],
          ['shards', [String(shardCounts.macos)]],
          ['shards', [shardCounts.macos, shardCounts.macos]],
          ['shards', [0]],
          ['shards', [3.5]],
          ['shard', null],
          ['shard', '1,2,3'],
          ['shard', [1, 2]],
          ['shard', [1, 2, 2]],
          ['shard', [3, 2, 1]],
          ['shard', Array.from({ length: shardCounts.macos }, (_, index) => String(index + 1))],
        ].map(([key, value]) => (workflow: ReturnType<typeof workflowFixture>) => {
          workflow.jobs['e2e-macos']!.strategy.matrix[key as string] = value
        }),
        ...['os', 'shard', 'shards'].map(
          (key) => (workflow: ReturnType<typeof workflowFixture>) => {
            delete workflow.jobs['e2e-macos']!.strategy.matrix[key]
          },
        ),
        ...['macos-15-intel', ['macos-latest'], null].map(
          (runner) => (workflow: ReturnType<typeof workflowFixture>) => {
            workflow.jobs['e2e-macos']!['runs-on'] = runner
          },
        ),
        ...[
          ['e2e', 4],
          ['e2e-macos', 2],
          ['e2e-macos', 5],
          ['e2e-windows', 3],
        ].map(([job, count]) => (workflow: ReturnType<typeof workflowFixture>) => {
          const matrix = workflow.jobs[job as string]!.strategy.matrix
          matrix.shard = Array.from({ length: count as number }, (_, index) => index + 1)
          matrix.shards = [count]
        }),
      ]
      for (const mutate of mutations) {
        const workflow = workflowFixture(shardCounts)
        mutate(workflow)
        expect(() => assertE2EShardTopology(JSON.stringify(workflow))).toThrow()
      }
    })
  }

  test('missing or malformed source documents fail closed', () => {
    for (const workflow of [
      '',
      'null',
      '[]',
      'true',
      '{}',
      'jobs: null',
      'jobs: []',
      'jobs: scalar',
      'jobs: [',
    ])
      expect(() => assertE2EShardTopology(workflow)).toThrow()
  })
})

describe('RFC-629 3/2/2 os-core CI and 0/3/4 cross-OS nightly E2E timing refresh', () => {
  const osCoreTests: DiscoveredE2ETest[] = OS_CORE_E2E_SPECS.map((file, index) => ({
    id: `core-${index}`,
    file,
    expectedStatus: 'passed',
  }))
  const nonCoreTests: DiscoveredE2ETest[] = [
    { id: 'extra-1', file: 'e2e/auth-isolation.spec.ts', expectedStatus: 'passed' },
    { id: 'extra-2', file: 'e2e/identity-access.spec.ts', expectedStatus: 'passed' },
  ]
  const fullTests: DiscoveredE2ETest[] = [...osCoreTests, ...nonCoreTests]

  const baseTimings = (): E2ETimings => ({
    version: 1,
    defaultMs: 60_000,
    platforms: {
      linux: {
        'e2e/main.spec.ts': 900,
        'e2e/auth-isolation.spec.ts': 800,
        'e2e/stale-linux.spec.ts': 700,
      },
      macos: {
        'e2e/main.spec.ts': 910,
        'e2e/auth-isolation.spec.ts': 810,
        'e2e/identity-access.spec.ts': 820,
      },
      windows: {
        'e2e/main.spec.ts': 920,
        'e2e/auth-isolation.spec.ts': 830,
        'e2e/identity-access.spec.ts': 840,
      },
    },
  })

  function buildTieredArtifacts(
    source: E2ETimingSource,
    perPlatform: Partial<
      Record<E2EPlatform, { tests: DiscoveredE2ETest[]; tier: E2ETier; durationMs?: number }>
    >,
  ) {
    return (Object.entries(source.shardCounts) as [E2EPlatform, number][]).flatMap(
      ([platform, total]) => {
        if (total === 0) return []
        const spec = perPlatform[platform]!
        const runner = platform === 'linux' ? 'Linux' : platform === 'macos' ? 'macOS' : 'Windows'
        return Array.from({ length: total }, (_, index) => {
          const plan = planE2EShards(
            spec.tests,
            { version: 1, defaultMs: 60_000, platforms: { linux: {}, macos: {}, windows: {} } },
            platform,
            index + 1,
            total,
            source.sourceSha,
            spec.tier,
          )
          const collector = new E2ETimingCollector(selectedE2ETests(plan))
          let now = 0
          const stepMs = spec.durationMs ?? 250
          for (const test of selectedE2ETests(plan)) {
            collector.begin(test.id, now)
            now += stepMs
            collector.end(test.id, test.expectedStatus, 0, now)
          }
          return {
            name: `e2e-test-timings-${runner}-${index + 1}`,
            plan,
            timings: {
              version: 1,
              measurement: 'first-test-begin-to-last-test-end-per-spec',
              sourceSha: source.sourceSha,
              runId: String(source.runId),
              runAttempt: '1',
              platform,
              shard: plan.shard,
              discoveryDigest: plan.discoveryDigest,
              status: 'passed',
              ...collector.snapshot(),
            },
          }
        })
      },
    )
  }

  test('3/2/2 os-core CI refresh requires --merge-base, updates linux full + macOS/Windows 19 OS-core specs, and preserves non-core entries', () => {
    const source: E2ETimingSource = {
      ...sourceMetadata,
      shardCounts: E2E_SHARD_COUNTS,
      sourceWorkflow: 'CI',
    }
    const artifacts = buildTieredArtifacts(source, {
      linux: { tests: fullTests, tier: 'pr-full', durationMs: 150 },
      macos: { tests: osCoreTests, tier: 'os-core', durationMs: 300 },
      windows: { tests: osCoreTests, tier: 'os-core', durationMs: 400 },
    })

    // Refuses partial refresh without --merge-base (prevents wiping non-os-core entries).
    expect(() => mergeE2ETimings(artifacts, source)).toThrow('--merge-base')

    const merged = mergeE2ETimings(artifacts, source, 60_000, baseTimings())
    expect(merged.provenance.sourceShardCounts).toEqual({ linux: 3, macos: 2, windows: 2 })
    expect(merged.provenance.sourceTiers).toEqual({
      linux: 'pr-full',
      macos: 'os-core',
      windows: 'os-core',
    })
    expect(merged.provenance.mergedFromBase).toBe(true)
    // Linux replaced completely (stale-linux removed, fullTests measured).
    expect(merged.platforms.linux['e2e/stale-linux.spec.ts']).toBeUndefined()
    expect(merged.platforms.linux['e2e/main.spec.ts']).toBe(150)
    expect(merged.platforms.linux['e2e/auth-isolation.spec.ts']).toBe(150)
    // macOS/Windows updated OS-core entries AND preserved non-core entries from baseTimings.
    expect(merged.platforms.macos['e2e/main.spec.ts']).toBe(300)
    expect(merged.platforms.macos['e2e/auth-isolation.spec.ts']).toBe(810)
    expect(merged.platforms.macos['e2e/identity-access.spec.ts']).toBe(820)
    expect(merged.platforms.windows['e2e/main.spec.ts']).toBe(400)
    expect(merged.platforms.windows['e2e/auth-isolation.spec.ts']).toBe(830)
    expect(merged.platforms.windows['e2e/identity-access.spec.ts']).toBe(840)

    // Wrong plan.tier fails closed.
    const wrongTier = buildTieredArtifacts(source, {
      linux: { tests: fullTests, tier: 'pr-full' },
      macos: { tests: osCoreTests, tier: 'pr-full' },
      windows: { tests: osCoreTests, tier: 'os-core' },
    })
    expect(() => mergeE2ETimings(wrongTier, source, 60_000, baseTimings())).toThrow(
      'source/platform/tier/shard',
    )

    // Extra spec in macOS os-core population fails closed against exact OS_CORE_E2E_SPECS set.
    const extraCoreSpec = buildTieredArtifacts(source, {
      linux: { tests: fullTests, tier: 'pr-full' },
      macos: { tests: fullTests, tier: 'os-core' },
      windows: { tests: osCoreTests, tier: 'os-core' },
    })
    expect(() => mergeE2ETimings(extraCoreSpec, source, 60_000, baseTimings())).toThrow(
      'OS_CORE_E2E_SPECS',
    )
  })

  test('0/3/4 cross-OS nightly refresh requires --merge-base, replaces macOS/Windows pr-full while preserving Linux, and validates live workflow', () => {
    const crossOsWorkflow = readFileSync(
      new URL('../../../.github/workflows/e2e-cross-os-nightly.yml', import.meta.url),
      'utf8',
    )
    expect(assertCrossOsNightlyE2ETopology(crossOsWorkflow)).toEqual(
      CROSS_OS_NIGHTLY_E2E_SHARD_COUNTS,
    )
    expect(() =>
      assertCrossOsNightlyE2ETopology(crossOsWorkflow.replace('shards: [4]', 'shards: [2]')),
    ).toThrow()

    const source: E2ETimingSource = {
      ...sourceMetadata,
      shardCounts: CROSS_OS_NIGHTLY_E2E_SHARD_COUNTS,
      sourceWorkflow: 'e2e-cross-os-nightly',
    }
    const artifacts = buildTieredArtifacts(source, {
      macos: { tests: fullTests, tier: 'pr-full', durationMs: 320 },
      windows: { tests: fullTests, tier: 'pr-full', durationMs: 420 },
    })
    expect(artifacts).toHaveLength(7)

    // Refuses without --merge-base (prevents wiping Linux entries).
    expect(() => mergeE2ETimings(artifacts, source)).toThrow('--merge-base')

    const merged = mergeE2ETimings(artifacts, source, 60_000, baseTimings())
    expect(merged.provenance.sourceWorkflow).toBe('e2e-cross-os-nightly')
    expect(merged.provenance.sourceShardCounts).toEqual({ linux: 0, macos: 3, windows: 4 })
    expect(merged.provenance.sourceTiers).toEqual({ macos: 'pr-full', windows: 'pr-full' })
    expect(merged.platforms.linux).toEqual(baseTimings().platforms.linux)
    expect(merged.platforms.macos['e2e/auth-isolation.spec.ts']).toBe(320)
    expect(merged.platforms.windows['e2e/identity-access.spec.ts']).toBe(420)

    // Rejects os-core tier on cross-OS nightly.
    const wrongNightlyTier = buildTieredArtifacts(source, {
      macos: { tests: osCoreTests, tier: 'os-core' },
      windows: { tests: fullTests, tier: 'pr-full' },
    })
    expect(() => mergeE2ETimings(wrongNightlyTier, source, 60_000, baseTimings())).toThrow(
      'source/platform/tier/shard',
    )

    // Source allowlist accepts schedule + workflow_dispatch on e2e-cross-os-nightly and rejects CI/push.
    const baseNightlyRun = {
      id: sourceMetadata.runId,
      name: 'e2e-cross-os-nightly',
      status: 'completed',
      conclusion: 'success',
      event: 'schedule',
      head_branch: 'main',
      head_sha: sourceMetadata.sourceSha,
      head_repository: { full_name: sourceMetadata.repository },
    }
    expect(
      assertSuccessfulTimingSource(
        baseNightlyRun,
        sourceMetadata.repository,
        sourceMetadata.runId,
        CROSS_OS_NIGHTLY_E2E_TIMING_SOURCES,
      ),
    ).toBe(sourceMetadata.sourceSha)
    expect(
      assertSuccessfulTimingSource(
        { ...baseNightlyRun, event: 'workflow_dispatch' },
        sourceMetadata.repository,
        sourceMetadata.runId,
        CROSS_OS_NIGHTLY_E2E_TIMING_SOURCES,
      ),
    ).toBe(sourceMetadata.sourceSha)
    for (const bad of [
      { name: 'CI', event: 'push' },
      { name: 'e2e-cross-os-nightly', event: 'push' },
      { name: 'backend-full-nightly', event: 'schedule' },
    ]) {
      expect(() =>
        assertSuccessfulTimingSource(
          { ...baseNightlyRun, ...bad },
          sourceMetadata.repository,
          sourceMetadata.runId,
          CROSS_OS_NIGHTLY_E2E_TIMING_SOURCES,
        ),
      ).toThrow('successful complete')
    }
  })

  test('parseRefreshE2ETimingsArgs parses --source and --merge-base flags and rejects invalid inputs', () => {
    expect(parseRefreshE2ETimingsArgs(['dir', '123', 'out.json'])).toEqual({
      sourceKind: 'ci',
      mergeBasePath: undefined,
      directory: 'dir',
      runId: 123,
      output: 'out.json',
    })
    expect(
      parseRefreshE2ETimingsArgs([
        '--source=cross-os-nightly',
        '--merge-base',
        'base.json',
        'dir',
        '456',
        'out.json',
      ]),
    ).toEqual({
      sourceKind: 'cross-os-nightly',
      mergeBasePath: 'base.json',
      directory: 'dir',
      runId: 456,
      output: 'out.json',
    })
    for (const bad of [
      ['--source=invalid', 'dir', '123', 'out.json'],
      ['--merge-base', '', 'dir', '123', 'out.json'],
      ['--unknown', 'dir', '123', 'out.json'],
      ['dir', 'abc', 'out.json'],
    ]) {
      expect(() => parseRefreshE2ETimingsArgs(bad)).toThrow()
    }
  })
})

function workflowFixture(shardCounts: E2EShardTopology) {
  const jobs: Record<
    string,
    {
      'runs-on': unknown
      strategy: { matrix: Record<string, unknown> }
    }
  > = {}
  for (const [platform, id, os] of [
    ['linux', 'e2e', 'ubuntu-24.04'],
    ['macos', 'e2e-macos', 'macos-latest'],
    ['windows', 'e2e-windows', 'windows-latest'],
  ] as const) {
    jobs[id] = {
      'runs-on': '${{ matrix.os }}',
      strategy: {
        matrix: {
          os: [os],
          shard: Array.from({ length: shardCounts[platform] }, (_, index) => index + 1),
          shards: [shardCounts[platform]],
        },
      },
    }
  }
  return { jobs }
}
