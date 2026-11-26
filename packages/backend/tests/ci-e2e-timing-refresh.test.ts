// RFC-611: incomplete, mixed-source or retried samples must not replace scheduling weights.
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertE2EShardTopology,
  E2E_SHARD_COUNTS,
  IneligibleE2ETimingSampleError,
  mergeE2ETimings,
  writeE2ETimingReview,
  type E2ETimingArtifact,
} from '../../../scripts/ci/refresh-e2e-timings'
import { planE2EShards, selectedE2ETests, type E2EPlatform } from '../../../scripts/ci/e2e-shards'
import { E2ETimingCollector } from '../../../scripts/ci/e2e-timings-reporter'

const source = {
  runId: 12345,
  sourceSha: 'a'.repeat(40),
  finalAttempt: 2,
  repository: 'owner/repo',
}

function retriedFixture() {
  const artifacts = fixture()
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
function fixture() {
  const tests = ['a', 'a', 'b', 'c', 'd', 'skip'].map((name, index) => ({
    id: `test-${index}`,
    file: `e2e/${name}.spec.ts`,
    expectedStatus: name === 'skip' ? 'skipped' : 'passed',
  }))
  return (Object.entries(E2E_SHARD_COUNTS) as [E2EPlatform, number][]).flatMap(
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

describe('complete E2E timing refresh', () => {
  test('all 3/4/4 source shards replace weights; skipped files remain; previous successful attempts remain valid', () => {
    const artifacts = fixture()
    artifacts[1]!.timings.runAttempt = '2'
    const merged = mergeE2ETimings(artifacts, source)
    expect(merged.version).toBe(1)
    expect(merged.defaultMs).toBe(60_000)
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
    const artifacts = fixture()
    expect(() => mergeE2ETimings(artifacts.slice(1), source)).toThrow('11')
    expect(() => mergeE2ETimings([artifacts[0]!, ...artifacts.slice(0, -1)], source)).toThrow(
      'Duplicate',
    )
    artifacts[0]!.name = 'e2e-test-timings-Solaris-1'
    expect(() => mergeE2ETimings(artifacts, source)).toThrow('name')
  })
  test('plan source/platform/shard and per-platform whole-population agreement are mandatory', () => {
    for (const mutation of ['sha', 'platform', 'shard', 'assignments']) {
      const artifacts = fixture()
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
      const artifacts = fixture()
      Object.assign(artifacts[0]!.timings, { [field]: value })
      expect(() => mergeE2ETimings(artifacts, source)).toThrow('evidence')
    }
  })
  test('each native test identity must have exactly one clean expected result', () => {
    for (const mutation of ['missing', 'duplicate', 'foreign', 'failed', 'retry', 'extra-result']) {
      const artifacts = fixture()
      const timing = artifacts[0]!.timings
      if (mutation === 'missing') timing.tests.pop()
      if (mutation === 'duplicate') timing.tests[1] = timing.tests[0]!
      if (mutation === 'foreign') timing.tests[0]!.id = 'foreign'
      if (mutation === 'failed') timing.tests[0]!.results[0]!.status = 'failed'
      if (mutation === 'retry') timing.tests[0]!.results[0]!.retry = 1
      if (mutation === 'extra-result') timing.tests[0]!.results.push({ status: 'passed', retry: 1 })
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
      const artifacts = fixture()
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
    const artifacts: E2ETimingArtifact[] = fixture()
    expect(() => mergeE2ETimings(artifacts, { ...source, sourceSha: 'short' })).toThrow('source')
    expect(() => mergeE2ETimings(artifacts, { ...source, finalAttempt: 0 })).toThrow('source')
    expect(() => mergeE2ETimings(artifacts, source, 0)).toThrow('positive')
  })
  test('complete passed serial retries are ineligible weights, with an explicit file reason', () => {
    const artifacts = retriedFixture()
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
      const artifacts = retriedFixture()
      const timing = artifacts[0]!.timings
      if (mutation === 'gap') timing.tests[0]!.results[1]!.retry = 2
      if (mutation === 'unknown-status') timing.tests[0]!.results[0]!.status = 'unknown'
      if (mutation === 'interrupted') timing.tests[0]!.results[0]!.status = 'interrupted'
      if (mutation === 'final-failure') timing.tests[0]!.results[1]!.status = 'failed'
      if (mutation === 'failed-skipped') timing.tests[0]!.results[1]!.status = 'skipped'
      if (mutation === 'clean') timing.files[timing.tests[0]!.file]!.clean = true
      if (mutation === 'attempts') timing.files[timing.tests[0]!.file]!.attempts++
      if (mutation === 'foreign') artifacts[10]!.timings.sourceSha = 'b'.repeat(40)
      if (mutation === 'partial') artifacts[10]!.timings.tests.pop()
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
      expect(writeE2ETimingReview(retriedFixture(), source, output)).toBe('skipped')
      expect(existsSync(output)).toBe(false)
      expect(JSON.parse(readFileSync(`${output}.status.json`, 'utf8'))).toMatchObject({
        status: 'skipped',
        reason: 'retried-tests',
        source,
      })
      expect(writeE2ETimingReview(fixture(), source, output)).toBe('updated')
      expect(JSON.parse(readFileSync(output, 'utf8')).platforms.linux['e2e/a.spec.ts']).toBe(200)
      expect(JSON.parse(readFileSync(`${output}.status.json`, 'utf8')).status).toBe('updated')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
  test('corruption still fails the review writer, and skipped sources cannot reuse stale weights', () => {
    const directory = mkdtempSync(join(tmpdir(), 'e2e-timing-review-'))
    const output = join(directory, 'weights.json')
    try {
      const artifacts = retriedFixture()
      artifacts[10]!.timings.complete = false
      expect(() => writeE2ETimingReview(artifacts, source, output)).toThrow('evidence')
      expect(existsSync(output)).toBe(false)
      expect(existsSync(`${output}.status.json`)).toBe(false)
      writeFileSync(output, 'previous weights')
      expect(() => writeE2ETimingReview(retriedFixture(), source, output)).toThrow('stale')
      expect(readFileSync(output, 'utf8')).toBe('previous weights')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
  test('the source-workflow contract keeps Linux 3, macOS 4 and Windows 4 shards', () => {
    const workflow = readFileSync(
      new URL('../../../.github/workflows/ci.yml', import.meta.url),
      'utf8',
    )
    expect(() => assertE2EShardTopology(workflow)).not.toThrow()
    expect(() => assertE2EShardTopology(workflow.replace('shards: [3]', 'shards: [4]'))).toThrow()
    expect(() =>
      assertE2EShardTopology(workflow.replace('shard: [1, 2, 3, 4]', 'shard: [1, 2, 4]')),
    ).toThrow()
    expect(() =>
      assertE2EShardTopology(workflow.replace('  e2e-windows:', '  e2e-missing:')),
    ).toThrow()
  })
})
