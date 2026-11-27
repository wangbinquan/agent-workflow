// RFC-611: duration planning must never omit, duplicate or split a discovered spec.
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FullConfig, Suite } from '@playwright/test/reporter'
import {
  assertE2ESelection,
  assertE2ERuntimeSelection,
  EXPECTED_E2E_WORKERS,
  e2ePlatform,
  exactE2EMatch,
  parseConfiguredE2EWorkers,
  parseE2EDiscovery,
  parseE2EShardPlan,
  parseE2ETimings,
  planE2EShards,
  selectedE2ETests,
  type DiscoveredE2ETest,
  type E2ETimings,
} from '../../../scripts/ci/e2e-shards'
import E2ETimingsReporter, { E2ETimingCollector } from '../../../scripts/ci/e2e-timings-reporter'

const discovered = (file: string, id = file, expectedStatus = 'passed'): DiscoveredE2ETest => ({
  id,
  file: `e2e/${file}.spec.ts`,
  expectedStatus,
})
const timingInput = (weights: Record<string, number> = {}): E2ETimings => ({
  version: 1,
  defaultMs: 60_000,
  platforms: { linux: weights, macos: weights, windows: weights },
})
const nativeReport = () => ({
  config: { rootDir: '/repo/e2e', shard: null },
  errors: [],
  suites: [
    {
      title: 'a.spec.ts',
      file: 'a.spec.ts',
      specs: [],
      suites: [
        {
          title: 'nested describe',
          file: 'a.spec.ts',
          specs: [
            {
              id: 'native-id',
              file: 'a.spec.ts',
              tests: [{ projectName: 'chromium', expectedStatus: 'passed', results: [] }],
            },
          ],
        },
      ],
    },
  ],
})

describe('native Playwright discovery input', () => {
  test('retains native identities and nested suites; normalizes Windows paths', () => {
    expect(parseE2EDiscovery(nativeReport(), '/repo')).toEqual([discovered('a', 'native-id')])
    const report = nativeReport()
    report.config.rootDir = 'C:/work/repo/e2e'
    expect(parseE2EDiscovery(report, 'C:\\work\\repo')).toEqual([discovered('a', 'native-id')])
    expect(e2ePlatform('macOS')).toBe('macos')
    expect(e2ePlatform('Windows')).toBe('windows')
    expect(() => e2ePlatform('Solaris')).toThrow()
  })
  test('rejects partial/error/executed/multiple-project discovery and path escape', () => {
    const base = nativeReport()
    expect(() =>
      parseE2EDiscovery({ ...base, errors: [{ message: 'load failed' }] }, '/repo'),
    ).toThrow('errors')
    expect(() =>
      parseE2EDiscovery(
        { ...base, config: { ...base.config, shard: { current: 1, total: 3 } } },
        '/repo',
      ),
    ).toThrow('sharding')
    for (const mutation of ['project', 'executed', 'escape', 'duplicate']) {
      const report = nativeReport()
      const spec = report.suites[0]!.suites[0]!.specs[0]!
      if (mutation === 'project') spec.tests[0]!.projectName = 'webkit'
      if (mutation === 'executed')
        Object.assign(spec.tests[0]!, { results: [{ status: 'passed' }] })
      if (mutation === 'escape') spec.file = '../../elsewhere.spec.ts'
      if (mutation === 'duplicate') report.suites.push(report.suites[0]!)
      expect(() => parseE2EDiscovery(report, '/repo')).toThrow()
    }
    expect(() => parseE2EDiscovery({ ...base, suites: [] }, '/repo')).toThrow('empty')
  })
})

describe('duration partitions', () => {
  const tests = [
    discovered('a', 'a1'),
    discovered('a', 'a2'),
    discovered('b'),
    discovered('c'),
    discovered('d'),
    discovered('new'),
  ]
  const timings = timingInput({
    'e2e/a.spec.ts': 240_000,
    'e2e/b.spec.ts': 210_000,
    'e2e/c.spec.ts': 30_000,
    'e2e/d.spec.ts': 20_000,
  })
  for (const [platform, total] of [
    ['linux', 3],
    ['macos', 3],
    ['macos', 4],
    ['windows', 4],
  ] as const) {
    test(`${platform} ${total} shards cover exactly the discovered files and test IDs, with no file split`, () => {
      const plans = Array.from({ length: total }, (_, index) =>
        planE2EShards(tests, timings, platform, index + 1, total),
      )
      const selected = plans.flatMap((plan) => selectedE2ETests(plan))
      const ids = selected.map((test) => test.id)
      expect(ids.sort()).toEqual(tests.map((test) => test.id).sort())
      expect(new Set(ids).size).toBe(ids.length)
      expect(selected.sort((a, b) => a.id.localeCompare(b.id))).toEqual(
        [...tests].sort((a, b) => a.id.localeCompare(b.id)),
      )
      const files = [...new Set(tests.map((test) => test.file))].sort()
      expect(plans[0]!.assignments.flat().sort()).toEqual(files)
      for (const file of files) {
        const owners = plans.filter((plan) =>
          selectedE2ETests(plan).some((test) => test.file === file),
        )
        expect(owners).toHaveLength(1)
        expect(
          selectedE2ETests(owners[0]!)
            .filter((test) => test.file === file)
            .map((test) => test.id)
            .sort(),
        ).toEqual(
          tests
            .filter((test) => test.file === file)
            .map((test) => test.id)
            .sort(),
        )
      }
      const a = plans.find((plan) => selectedE2ETests(plan).some((test) => test.id === 'a1'))!
      expect(selectedE2ETests(a).map((test) => test.id)).toContain('a2')
      expect(plans[0]!.assignments.findIndex((files) => files.includes('e2e/a.spec.ts'))).not.toBe(
        plans[0]!.assignments.findIndex((files) => files.includes('e2e/b.spec.ts')),
      )
      for (const plan of plans) {
        expect(plan.tests).toEqual(plans[0]!.tests)
        expect(plan.discoveryDigest).toBe(plans[0]!.discoveryDigest)
        expect(plan.assignments).toEqual(plans[0]!.assignments)
        expect(parseE2EShardPlan(JSON.parse(JSON.stringify(plan)))).toEqual(plan)
      }
    })
    test(`${platform} ${total} shards retain a new spec with the conservative fallback regardless of input order`, () => {
      const plan = planE2EShards(tests, timings, platform, 1, total)
      expect(plan.unknownFiles).toEqual(['e2e/new.spec.ts'])
      expect(plan.assignments.flat().filter((file) => file === 'e2e/new.spec.ts')).toHaveLength(1)
      expect(plan.estimatedShardMs.reduce((a, b) => a + b, 0)).toBe(560_000)
      expect(planE2EShards([...tests].reverse(), timings, platform, 1, total)).toEqual(plan)
    })
  }
  test('macOS three and historical four shards retain the same native population, including expected skips', () => {
    const input = [...tests, discovered('disabled', 'skip', 'skipped')]
    const expected = [...input].sort((a, b) => a.id.localeCompare(b.id))
    const populations = [3, 4].map((total) =>
      Array.from({ length: total }, (_, index) =>
        planE2EShards(input, timings, 'macos', index + 1, total),
      ),
    )
    for (const plans of populations) {
      // Exactly once describes shard ownership, not the number of execution
      // attempts. Expected skips and the existing retry policy remain intact.
      const selected = plans.flatMap((plan) => selectedE2ETests(plan))
      expect(selected.sort((a, b) => a.id.localeCompare(b.id))).toEqual(expected)
      expect(new Set(selected.map((test) => test.id)).size).toBe(input.length)
      for (const plan of plans)
        expect([...plan.tests].sort((a, b) => a.id.localeCompare(b.id))).toEqual(expected)
    }
    expect(new Set(populations.flat().map((plan) => plan.discoveryDigest)).size).toBe(1)
  })
  test('every macOS three-shard runtime selection rejects omitted, duplicate, foreign identities and wrong workers', () => {
    expect(EXPECTED_E2E_WORKERS).toEqual({ linux: 4, macos: 3, windows: 4 })
    const config = { shard: null, workers: 3, fullyParallel: false }
    for (const current of [1, 2, 3]) {
      const plan = planE2EShards(tests, timings, 'macos', current, 3)
      const ids = selectedE2ETests(plan).map((test) => test.id)
      expect(() => assertE2ERuntimeSelection(plan, ids, config)).not.toThrow()
      expect(() => assertE2ERuntimeSelection(plan, ids, { ...config, workers: 4 })).toThrow(
        'requires 3 workers',
      )
      expect(() => assertE2ERuntimeSelection(plan, ids, { ...config, workers: 2 })).toThrow(
        'requires 3 workers',
      )
      expect(() => assertE2ERuntimeSelection(plan, ids.slice(1), config)).toThrow('coverage')
      expect(() => assertE2ERuntimeSelection(plan, [...ids, ids[0]!], config)).toThrow('coverage')
      expect(() =>
        assertE2ERuntimeSelection(plan, ['foreign-id', ...ids.slice(1)], config),
      ).toThrow('coverage')
      const otherShardId = tests.find((test) => !ids.includes(test.id))!.id
      expect(() =>
        assertE2ERuntimeSelection(plan, [otherShardId, ...ids.slice(1)], config),
      ).toThrow('coverage')
    }
  })

  test('AW_E2E_WORKERS parser accepts 1..8 or empty and rejects malformed worker counts', () => {
    expect(parseConfiguredE2EWorkers(undefined)).toBeUndefined()
    expect(parseConfiguredE2EWorkers('')).toBeUndefined()
    for (let workers = 1; workers <= 8; workers++) {
      expect(parseConfiguredE2EWorkers(String(workers))).toBe(workers)
    }
    for (const invalid of ['0', '9', '-1', '3.5', 'abc', ' 3', '3 ', '03']) {
      expect(() => parseConfiguredE2EWorkers(invalid)).toThrow('AW_E2E_WORKERS')
    }
  })
  test('OS weights are distinct, obsolete weights add no tests, and skipped files are still assigned', () => {
    const weights = timingInput({
      'e2e/a.spec.ts': 2,
      'e2e/b.spec.ts': 1,
      'e2e/obsolete.spec.ts': 999,
    })
    weights.platforms.windows = { 'e2e/a.spec.ts': 1, 'e2e/b.spec.ts': 2 }
    const input = [discovered('a'), discovered('b'), discovered('disabled', 'skip', 'skipped')]
    const linux = planE2EShards(input, weights, 'linux', 1, 2)
    const windows = planE2EShards(input, weights, 'windows', 1, 2)
    expect(linux.assignments[0]).toContain('e2e/a.spec.ts')
    expect(windows.assignments[0]).toContain('e2e/b.spec.ts')
    expect(linux.assignments.flat().sort()).toEqual(input.map((test) => test.file).sort())
    expect(linux.unknownFiles).toEqual([])
  })
  test('rejects invalid shards, omitted/duplicated files, digest tampering and actual double-sharding', () => {
    for (const [n, m] of [
      [0, 3],
      [4, 3],
      [1, 0],
      [1, 9],
      [1.5, 3],
    ])
      expect(() => planE2EShards(tests, timings, 'linux', n!, m!)).toThrow()
    const plan = planE2EShards(tests, timings, 'linux', 1, 3)
    for (const mutate of ['omit', 'duplicate', 'digest']) {
      const invalid = structuredClone(plan)
      if (mutate === 'omit') invalid.assignments[0]!.pop()
      if (mutate === 'duplicate') invalid.assignments[1]!.push(invalid.assignments[0]![0]!)
      if (mutate === 'digest') invalid.discoveryDigest = 'incorrect'
      expect(() => parseE2EShardPlan(invalid)).toThrow()
    }
    const ids = selectedE2ETests(plan).map((test) => test.id)
    expect(() => assertE2ESelection(plan, ids)).not.toThrow()
    expect(() => assertE2ESelection(plan, ids.slice(1))).toThrow('coverage')
    expect(() => assertE2ESelection(plan, [...ids, ids[0]!])).toThrow('coverage')
    const config = { shard: null, workers: 4, fullyParallel: false }
    expect(() => assertE2ERuntimeSelection(plan, ids, config)).not.toThrow()
    expect(() =>
      assertE2ERuntimeSelection(plan, ids, { ...config, shard: { current: 1, total: 3 } }),
    ).toThrow('native --shard')
    expect(() => assertE2ERuntimeSelection(plan, ids, { ...config, workers: 3 })).toThrow(
      'requires 4 workers',
    )
    const windowsPlan = planE2EShards(tests, timings, 'windows', 1, 4)
    const windowsIds = selectedE2ETests(windowsPlan).map((test) => test.id)
    expect(() => assertE2ERuntimeSelection(windowsPlan, windowsIds, config)).not.toThrow()
    expect(() =>
      assertE2ERuntimeSelection(windowsPlan, windowsIds, { ...config, workers: 3 }),
    ).toThrow('requires 4 workers')
    expect(() => assertE2ERuntimeSelection(plan, ids, { ...config, fullyParallel: true })).toThrow(
      'sequential',
    )
  })
  test('invalid or escaping timing entries are refused; regex paths are exact on both OS separators', () => {
    expect(parseE2ETimings(timingInput())).toEqual(timingInput())
    for (const ms of [0, -1, Infinity, NaN])
      expect(() => parseE2ETimings(timingInput({ 'e2e/a.spec.ts': ms }))).toThrow()
    expect(() => parseE2ETimings(timingInput({ 'e2e/../a.spec.ts': 10 }))).toThrow()
    expect(() => parseE2ETimings({ ...timingInput(), version: 2 })).toThrow()
    const pattern = exactE2EMatch('C:\\repo\\e2e\\nested\\a[1]+.spec.ts')
    expect(pattern.test('C:/repo/e2e/nested/a[1]+.spec.ts')).toBe(true)
    expect(pattern.test('C:\\repo\\e2e\\nested\\a[1]+.spec.ts')).toBe(true)
    expect(pattern.test('C:/repo/e2e/nested/a1.spec.ts')).toBe(false)
    expect(pattern.test('C:/repo/e2e/nested/a[1]+.spec.ts.extra')).toBe(false)
  })
})

describe('whole-spec timing windows', () => {
  test('a reporter selection mismatch explicitly overrides a passed Playwright result', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'aw-e2e-reporter-'))
    try {
      const planPath = join(directory, 'plan.json')
      const plan = planE2EShards([discovered('a')], timingInput(), 'linux', 1, 1)
      writeFileSync(planPath, JSON.stringify(plan))
      const reporter = new E2ETimingsReporter({ planPath })
      const config = { shard: null, workers: 4, fullyParallel: false } as FullConfig
      // Reporter callback exceptions are swallowed by Playwright; no throw is
      // sufficient. The asynchronous onEnd result must force the run to fail.
      reporter.onBegin(config, { allTests: () => [] } as unknown as Suite)
      expect(
        await reporter.onEnd({ status: 'passed', startTime: new Date(), duration: 1 }),
      ).toEqual({
        status: 'failed',
      })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('measures before/after-hook time and gaps rather than summing test bodies', () => {
    const collector = new E2ETimingCollector([
      discovered('a', 'a1'),
      discovered('a', 'a2'),
      discovered('b'),
    ])
    collector.begin('a1', 10)
    collector.begin('b', 12)
    collector.end('a1', 'passed', 0, 200)
    collector.begin('a2', 210)
    collector.end('b', 'passed', 0, 250)
    expect(collector.snapshot().complete).toBe(false)
    collector.end('a2', 'passed', 0, 400)
    const snapshot = collector.snapshot()
    expect(snapshot.complete).toBe(true)
    expect(snapshot.files['e2e/a.spec.ts']).toEqual({
      durationMs: 390,
      complete: true,
      clean: true,
      attempts: 2,
      runnable: true,
    })
    expect(snapshot.files['e2e/b.spec.ts']!.durationMs).toBe(238)
  })
  test('retry and incomplete evidence cannot masquerade as a clean complete sample', () => {
    const collector = new E2ETimingCollector([discovered('a'), discovered('b')])
    collector.begin('a', 0)
    collector.end('a', 'failed', 0, 100)
    collector.begin('a', 200)
    collector.end('a', 'passed', 1, 300)
    expect(collector.snapshot().complete).toBe(false)
    expect(collector.snapshot().files['e2e/a.spec.ts']!.clean).toBe(false)
    expect(collector.snapshot().files['e2e/a.spec.ts']!.durationMs).toBe(300)
    expect(collector.snapshot().files['e2e/b.spec.ts']!.complete).toBe(false)
    expect(() => collector.begin('foreign', 0)).toThrow('Unexpected')
  })
})
