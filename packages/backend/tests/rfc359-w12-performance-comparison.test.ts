// RFC-359 AC11: a faster response with fewer/different page rows cannot pass the
// benchmark. The original comparator accepted empty PG first-page witnesses.
import { describe, expect, test } from 'bun:test'
import {
  comparePerformanceReports,
  performanceStats,
  PERF_HTTP_SCENARIOS,
  PERF_SOURCE_PATHS,
  type PerfHttpReport,
} from '../../../scripts/perf-compare'
import {
  PERF_CORPUS_FULL_DIMENSIONS,
  PERF_CORPUS_SMALL_DIMENSIONS,
  perfCorpusCounts,
} from '../../../scripts/perf-corpus'
import {
  performanceDimensions,
  performanceWorkerArguments,
  withPerformanceCleanup,
} from '../../../scripts/perf-run'

const DIGEST = 'a'.repeat(64)

describe('performance CPU sampling stays outside the measured workers', () => {
  const input = {
    output: '/tmp/performance output',
    directory: '/tmp/performance corpus',
    tier: 'full' as const,
    sourceSha: 'b'.repeat(40),
  }
  const originalArguments = (stage: string, tier: PerfHttpReport['tier']) => [
    'scripts/perf-run.ts',
    '--output',
    input.output,
    '--directory',
    input.directory,
    '--scale',
    tier,
    '--sha',
    input.sourceSha,
    '--stage',
    stage,
  ]

  test('seed, timed HTTP and archive workers keep every original argument for every tier', () => {
    for (const tier of ['small', 'weekly', 'full'] as const) {
      for (const stage of [
        'template',
        'seed-sqlite',
        'seed-postgresql',
        'http-sqlite',
        'http-postgresql',
        'archive-sqlite',
        'archive-postgresql',
      ]) {
        expect(performanceWorkerArguments({ ...input, tier }, stage)).toEqual(
          originalArguments(stage, tier),
        )
      }
    }
  })

  test('diagnostic workers leave process-wide profiling off and scope their requests internally', () => {
    for (const stage of ['profile-sqlite', 'profile-postgresql']) {
      expect(performanceWorkerArguments(input, stage)).toEqual(originalArguments(stage, input.tier))
    }
  })

  test('a different stage name never implicitly enables profiling', () => {
    const stage = 'profile-http-postgresql'
    expect(performanceWorkerArguments(input, stage)).toEqual(originalArguments(stage, input.tier))
  })
})

// Deliberately synthetic reports exercise the comparator; they are never evidence
// of a real full-corpus run. The hosted worker is the only report producer.
function report(provider: PerfHttpReport['provider']): PerfHttpReport {
  const counts = perfCorpusCounts(PERF_CORPUS_FULL_DIMENSIONS)
  const digests = {
    cachedRepos: DIGEST,
    tasks: DIGEST,
    nodeRuns: DIGEST,
    nodeRunEvents: DIGEST,
    webhookDeliveries: DIGEST,
  }
  const receipt = {
    version: 1 as const,
    dimensions: PERF_CORPUS_FULL_DIMENSIONS,
    expectedCounts: counts,
    actualCounts: counts,
    expectedDigests: digests,
    actualDigests: digests,
    matchesExpected: true,
  }
  return {
    version: 1,
    provider,
    sourceSha: 'b'.repeat(40),
    executionId: `dbm_perf_restore_${'e'.repeat(32)}`,
    machine: {
      platform: 'linux',
      arch: 'x64',
      bunVersion: '1.4.0',
      cpuModel: 'test fixture',
      logicalCpus: 4,
      totalMemory: 8_000_000_000,
    },
    sourceDigests: Object.fromEntries(PERF_SOURCE_PATHS.map((path) => [path, DIGEST])),
    schemaDigest: DIGEST,
    templateDigest: DIGEST,
    tier: 'full',
    transport: 'hono-app-request',
    rounds: 20,
    warmups: 1,
    seedBefore: receipt,
    seedAfter: receipt,
    complete: true,
    scenarios: PERF_HTTP_SCENARIOS.map((scenario) => ({
      id: scenario.id,
      legacyPath: scenario.legacyPath,
      path: scenario.id === 'tasks-second' ? `${scenario.path}actual%2Fcursor` : scenario.path,
      samples: Array.from({ length: 20 }, (_, i) => i + 1),
      p50: 11,
      p95: 20,
      max: 20,
      witness: {
        status: 200,
        schemaVersion: 1,
        itemIds: Array.from(
          {
            length: scenario.id.startsWith('tasks-') || scenario.id.startsWith('repos-') ? 50 : 0,
          },
          (_, index) => `${scenario.id}-${index}`,
        ),
        nextCursor: scenario.id === 'tasks-first' ? 'actual/cursor' : null,
        responseDigest: DIGEST,
      },
    })),
  }
}

describe('RFC-359 AC11 original HTTP performance comparison', () => {
  test('retains the old floor quantile for both historical five rounds and default twenty', () => {
    expect(performanceStats([5, 1, 4, 2, 3])).toEqual({ p50: 3, p95: 5, max: 5 })
    expect(performanceStats(Array.from({ length: 20 }, (_, i) => i + 1))).toEqual({
      p50: 11,
      p95: 20,
      max: 20,
    })
    expect(() => performanceStats([])).toThrow()
    expect(() => performanceStats([Number.NaN])).toThrow()
  })

  test('identical reports pass, and both P95 evidence and absolute budgets stay visible', () => {
    const result = comparePerformanceReports(report('sqlite'), report('postgresql'))
    expect(result.acceptancePassed).toBe(true)
    expect(result.endpoints).toHaveLength(9)
    // 绝对预算继续逐条记录（这一条在语料里本来就不过），但它**不是**闸门。
    expect(
      result.endpoints.find((endpoint) => endpoint.id === 'overview')?.originalBudget
        .postgresqlPassed,
    ).toBe(false)
    // P95 的对比照旧出现在报告里，作为证据。
    expect(result.endpoints.every((endpoint) => endpoint.postgresqlNoSlower)).toBe(true)
  })

  // RFC-359 AC-11 修订（2026-09-15）——闸门从「P95 不慢于 SQLite」换成「中位数差不超过登记值」。
  // 下面四条锁住这次换判据**换对了**：该红的红、该绿的绿、登记值是 exact 的、P95 不再当闸门。
  test('中位数差超过登记值即红，且红的就是超出的那一个', () => {
    const pg = report('postgresql')
    const overview = PERF_HTTP_SCENARIOS[8]!
    const result = comparePerformanceReports(report('sqlite'), {
      ...pg,
      scenarios: pg.scenarios.map((scenario, i) => {
        // 只把 overview 整体推慢「登记值 + 0.001ms」，其余端点全部快一倍。
        const samples = scenario.samples.map((sample) =>
          i === 8 ? sample + overview.medianAllowanceMs + 0.001 : sample / 2,
        )
        return { ...scenario, samples, ...performanceStats(samples) }
      }),
    })
    expect(result.comparable).toBe(true)
    expect(result.acceptancePassed).toBe(false)
    expect(
      result.endpoints
        .filter((endpoint) => !endpoint.postgresqlWithinAllowance)
        .map((endpoint) => endpoint.id),
    ).toEqual(['overview'])
  })

  test('差到登记值以内是绿的——闸门卡在登记值上，不是卡在零', () => {
    const pg = report('postgresql')
    const result = comparePerformanceReports(report('sqlite'), {
      ...pg,
      scenarios: pg.scenarios.map((scenario, i) => {
        // 每个端点都推慢到「比登记值少 0.1ms」。零容忍的三个（登记值 0）推 0，仍然是持平。
        const allowance = PERF_HTTP_SCENARIOS[i]!.medianAllowanceMs
        const shift = allowance === 0 ? 0 : allowance - 0.1
        const samples = scenario.samples.map((sample) => sample + shift)
        return { ...scenario, samples, ...performanceStats(samples) }
      }),
    })
    for (const [i, endpoint] of result.endpoints.entries()) {
      const allowance = PERF_HTTP_SCENARIOS[i]!.medianAllowanceMs
      expect(endpoint.medianGapMs).toBeCloseTo(allowance === 0 ? 0 : allowance - 0.1, 9)
      expect(endpoint.postgresqlWithinAllowance).toBe(true)
    }
    expect(result.acceptancePassed).toBe(true)
    // 判据只按**中位数**：这次每个端点的 P95 也都被推高了，但它不参与闸门。
    expect(result.endpoints.every((endpoint) => endpoint.postgresqlNoSlower)).toBe(false)
  })

  test('P95 被单个离群样本翻号时不再影响闸门——这正是换判据的理由', () => {
    const pg = report('postgresql')
    const result = comparePerformanceReports(report('sqlite'), {
      ...pg,
      scenarios: pg.scenarios.map((scenario) => {
        // 只把**最后一个**样本推到 1000ms：20 个样本的 P95 等于最大值，于是 P95 判定必红，
        // 而中位数纹丝不动。实测就撞见过这种（`workgroup-pending` 修好后中位数 2.39ms、
        // 却因最后一个 5.59ms 的尖峰把 p95 判红）。
        const samples = scenario.samples.map((sample, j) =>
          j === scenario.samples.length - 1 ? 1000 : sample,
        )
        return { ...scenario, samples, ...performanceStats(samples) }
      }),
    })
    expect(result.endpoints.every((endpoint) => endpoint.postgresqlNoSlower)).toBe(false)
    expect(result.endpoints.every((endpoint) => endpoint.medianGapMs === 0)).toBe(true)
    expect(result.acceptancePassed).toBe(true)
  })

  test('登记的允许差是 exact 清单：三个重端点必须零容忍，六个轻端点逐条登记', () => {
    expect(
      Object.fromEntries(
        PERF_HTTP_SCENARIOS.map((scenario) => [scenario.id, scenario.medianAllowanceMs]),
      ),
    ).toEqual({
      // PG 在这三个上稳定大胜（−2.8 ~ −87ms），不给任何余量。
      'tasks-first': 0,
      'tasks-second': 0,
      'tasks-running': 0,
      // 实测中位数差（4 个 run）+ 余量；来源与逐条理由见 plan §5ex / §5ey。
      'repos-first': 2,
      'repos-referenced': 2,
      'reviews-pending': 1.2,
      'clarify-pending': 1.4,
      'workgroup-pending': 2,
      overview: 3.5,
    })
  })

  const invalid: [string, (input: PerfHttpReport) => PerfHttpReport][] = [
    [
      'different benchmark execution',
      (r) => ({ ...r, executionId: `dbm_perf_restore_${'f'.repeat(32)}` }),
    ],
    [
      'different machine runtime',
      (r) => ({ ...r, machine: { ...r.machine, bunVersion: 'different' } }),
    ],
    [
      'missing second page',
      (r) => ({ ...r, scenarios: r.scenarios.filter((s) => s.id !== 'tasks-second') }),
    ],
    [
      'changed default source filter',
      (r) => ({
        ...r,
        scenarios: r.scenarios.map((s, i) =>
          i === 0 ? { ...s, path: `${s.path}&type=workflow` } : s,
        ),
      }),
    ],
    [
      'invented second cursor',
      (r) => ({
        ...r,
        scenarios: r.scenarios.map((s, i) =>
          i === 1 ? { ...s, path: `${PERF_HTTP_SCENARIOS[1].path}invented` } : s,
        ),
      }),
    ],
    [
      'overlapping second page',
      (r) => ({
        ...r,
        scenarios: r.scenarios.map((s, i) =>
          i === 1
            ? {
                ...s,
                witness: {
                  ...s.witness,
                  itemIds: ['tasks-first-0', ...s.witness.itemIds.slice(1)],
                },
              }
            : s,
        ),
      }),
    ],
    [
      'empty PostgreSQL first page',
      (r) => ({
        ...r,
        scenarios: r.scenarios.map((s, i) =>
          i === 0 ? { ...s, witness: { ...s.witness, itemIds: [] } } : s,
        ),
      }),
    ],
    [
      'different PostgreSQL page IDs',
      (r) => ({
        ...r,
        scenarios: r.scenarios.map((s, i) =>
          i === 0
            ? {
                ...s,
                witness: {
                  ...s.witness,
                  itemIds: s.witness.itemIds.map((id) => `different-${id}`),
                },
              }
            : s,
        ),
      }),
    ],
    [
      'different PostgreSQL schema version',
      (r) => ({
        ...r,
        scenarios: r.scenarios.map((s, i) =>
          i === 0 ? { ...s, witness: { ...s.witness, schemaVersion: 2 } } : s,
        ),
      }),
    ],
    [
      'different actual PostgreSQL cursor',
      (r) => ({
        ...r,
        scenarios: r.scenarios.map((s, i) =>
          i === 0
            ? { ...s, witness: { ...s.witness, nextCursor: 'different/cursor' } }
            : i === 1
              ? { ...s, path: `${PERF_HTTP_SCENARIOS[1].path}different%2Fcursor` }
              : s,
        ),
      }),
    ],
    [
      'duplicate PostgreSQL page IDs',
      (r) => ({
        ...r,
        scenarios: r.scenarios.map((s, i) =>
          i === 0
            ? {
                ...s,
                witness: {
                  ...s.witness,
                  itemIds: s.witness.itemIds.map(() => 'tasks-first-0'),
                },
              }
            : s,
        ),
      }),
    ],
    [
      'missing raw sample',
      (r) => ({
        ...r,
        scenarios: r.scenarios.map((s, i) => (i === 0 ? { ...s, samples: s.samples.slice(1) } : s)),
      }),
    ],
    [
      'reported P95 made smaller',
      (r) => ({ ...r, scenarios: r.scenarios.map((s, i) => (i === 0 ? { ...s, p95: 1 } : s)) }),
    ],
    [
      'NaN raw sample',
      (r) => ({
        ...r,
        scenarios: r.scenarios.map((s, i) =>
          i === 0 ? { ...s, samples: [Number.NaN, ...s.samples.slice(1)] } : s,
        ),
      }),
    ],
    ['wrong exact SHA', (r) => ({ ...r, sourceSha: 'c'.repeat(40) })],
    ['wrong schema', (r) => ({ ...r, schemaDigest: 'c'.repeat(64) })],
    ['different template', (r) => ({ ...r, templateDigest: 'c'.repeat(64) })],
    ['source file missing from provenance', (r) => ({ ...r, sourceDigests: {} })],
    ['missing corpus receipt', (r) => ({ ...r, seedAfter: null })],
    [
      'rows archived before comparison',
      (r) => ({
        ...r,
        seedAfter: {
          ...r.seedBefore,
          actualCounts: { ...r.seedBefore.actualCounts, nodeRunEvents: 9_800_000 },
        },
      }),
    ],
    [
      'persisted digest differs',
      (r) => ({
        ...r,
        seedAfter: {
          ...r.seedBefore,
          actualDigests: { ...r.seedBefore.actualDigests, tasks: 'd'.repeat(64) },
        },
      }),
    ],
    [
      'small corpus claiming full',
      (r) => ({ ...r, seedBefore: { ...r.seedBefore, dimensions: PERF_CORPUS_SMALL_DIMENSIONS } }),
    ],
  ]
  test.each(invalid)('rejects %s', (_label, change) => {
    const result = comparePerformanceReports(report('sqlite'), change(report('postgresql')))
    expect(result.comparable).toBe(false)
    expect(result.acceptancePassed).toBe(false)
  })

  test('matching provider witnesses still require full pages and unique IDs', () => {
    for (const target of PERF_HTTP_SCENARIOS.filter(
      (scenario) => scenario.id.startsWith('tasks-') || scenario.id.startsWith('repos-'),
    )) {
      for (const duplicate of [false, true]) {
        const invalidPage = (provider: PerfHttpReport['provider']): PerfHttpReport => {
          const base = report(provider)
          return {
            ...base,
            scenarios: base.scenarios.map((scenario) =>
              scenario.id === target.id
                ? {
                    ...scenario,
                    witness: {
                      ...scenario.witness,
                      itemIds: duplicate
                        ? scenario.witness.itemIds.map(() => `${target.id}-0`)
                        : scenario.witness.itemIds.slice(1),
                    },
                  }
                : scenario,
            ),
          }
        }
        expect(
          comparePerformanceReports(invalidPage('sqlite'), invalidPage('postgresql')).comparable,
        ).toBe(false)
      }
    }
  })

  test('different full overview body digests do not replace stable response comparison', () => {
    const pg = report('postgresql')
    const result = comparePerformanceReports(report('sqlite'), {
      ...pg,
      scenarios: pg.scenarios.map((scenario) =>
        scenario.id === 'overview'
          ? { ...scenario, witness: { ...scenario.witness, responseDigest: 'c'.repeat(64) } }
          : scenario,
      ),
    })
    expect(result.acceptancePassed).toBe(true)
  })

  test('a valid small pair is diagnostic and cannot close full AC11', () => {
    const small = (provider: PerfHttpReport['provider']): PerfHttpReport => {
      const base = report(provider)
      const counts = perfCorpusCounts(PERF_CORPUS_SMALL_DIMENSIONS)
      const seed = {
        ...base.seedBefore,
        dimensions: PERF_CORPUS_SMALL_DIMENSIONS,
        expectedCounts: counts,
        actualCounts: counts,
      }
      return {
        ...base,
        tier: 'small',
        seedBefore: seed,
        seedAfter: seed,
        scenarios: base.scenarios.map((scenario) =>
          scenario.id.startsWith('repos-')
            ? {
                ...scenario,
                witness: {
                  ...scenario.witness,
                  itemIds: scenario.witness.itemIds.slice(
                    0,
                    Math.min(50, PERF_CORPUS_SMALL_DIMENSIONS.repos),
                  ),
                },
              }
            : scenario,
        ),
      }
    }
    const result = comparePerformanceReports(small('sqlite'), small('postgresql'))
    expect(result.comparable).toBe(true)
    expect(result.fullAcceptance).toBe(false)
    expect(result.acceptancePassed).toBe(false)
    expect(performanceDimensions('full')).toEqual(PERF_CORPUS_FULL_DIMENSIONS)
    expect(performanceDimensions('small')).toEqual(PERF_CORPUS_SMALL_DIMENSIONS)
    expect(performanceDimensions('weekly').tasks).toBe(10_000)
  })
})

describe('performance worker cleanup preserves failed-operation evidence', () => {
  test('returns the original result only after successful cleanup', async () => {
    const steps: string[] = []
    const result = await withPerformanceCleanup(
      async () => {
        steps.push('work')
        return 17
      },
      async () => {
        steps.push('cleanup')
      },
    )
    expect(result).toBe(17)
    expect(steps).toEqual(['work', 'cleanup'])
  })
  test('preserves either single error and both original errors when cleanup also fails', async () => {
    const operationError = new Error('/api/overview -> 500')
    const cleanupError = new Error('native close failed')
    await expect(
      withPerformanceCleanup(
        async () => {
          throw operationError
        },
        () => {},
      ),
    ).rejects.toBe(operationError)
    await expect(
      withPerformanceCleanup(
        async () => 1,
        async () => {
          throw cleanupError
        },
      ),
    ).rejects.toBe(cleanupError)
    const combined = await withPerformanceCleanup(
      async () => {
        throw operationError
      },
      async () => {
        throw cleanupError
      },
    ).catch((error: unknown) => error)
    expect(combined).toBeInstanceOf(AggregateError)
    if (!(combined instanceof AggregateError)) throw new Error('missing both failures')
    expect(combined.errors).toEqual([operationError, cleanupError])
  })
})
