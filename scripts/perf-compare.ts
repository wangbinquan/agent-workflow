// RFC-359 AC11: retain RFC-311's raw, per-endpoint P95 comparison.
import { readFileSync, writeFileSync } from 'node:fs'
import { PERF_CORPUS_FULL_DIMENSIONS, perfCorpusCounts } from './perf-corpus'
import type { PerfCorpusSeedReceipt } from './perf-seed'

export const PERF_HTTP_SCENARIOS = [
  {
    id: 'tasks-first',
    label: '§6.1 tasks/page default first page',
    legacyPath: '/api/tasks/page?limit=50',
    path: '/api/task-catalog?limit=50',
    budgetMs: 150,
    budgetStatistic: 'p95',
  },
  {
    id: 'tasks-second',
    label: '§6.1 tasks/page second page',
    legacyPath: '/api/tasks/page?limit=50&cursor=',
    path: '/api/task-catalog?limit=50&cursor=',
    budgetMs: 150,
    budgetStatistic: 'p95',
  },
  {
    id: 'tasks-running',
    label: '§6.1 tasks/page running view (filtered)',
    legacyPath: '/api/tasks/page?limit=50&statuses=running',
    path: '/api/task-catalog?limit=50&statuses=running',
    budgetMs: 150,
    budgetStatistic: 'p95',
  },
  {
    id: 'repos-first',
    label: '§6.2 cached-repos first page',
    legacyPath: '/api/cached-repos?limit=50',
    path: '/api/cached-repos?limit=50',
    budgetMs: 100,
    budgetStatistic: 'p95',
  },
  {
    id: 'repos-referenced',
    label: '§6.2 cached-repos referenced view',
    legacyPath: '/api/cached-repos?limit=50&view=referenced',
    path: '/api/cached-repos?limit=50&view=referenced',
    budgetMs: 100,
    budgetStatistic: 'p95',
  },
  {
    id: 'reviews-pending',
    label: '§6.3 reviews/pending-count',
    legacyPath: '/api/reviews/pending-count',
    path: '/api/reviews/pending-count',
    budgetMs: 10,
    budgetStatistic: 'max',
  },
  {
    id: 'clarify-pending',
    label: '§6.3 clarify/pending-count',
    legacyPath: '/api/clarify/pending-count',
    path: '/api/clarify/pending-count',
    budgetMs: 10,
    budgetStatistic: 'max',
  },
  {
    id: 'workgroup-pending',
    label: '§6.3 workgroup-tasks/pending-count',
    legacyPath: '/api/workgroup-tasks/pending-count',
    path: '/api/workgroup-tasks/pending-count',
    budgetMs: 10,
    budgetStatistic: 'max',
  },
  {
    id: 'overview',
    label: '§6.3 overview',
    legacyPath: '/api/overview',
    path: '/api/overview',
    budgetMs: 10,
    budgetStatistic: 'max',
  },
] as const

export const PERF_SOURCE_PATHS = [
  'scripts/perf-corpus.ts',
  'scripts/perf-seed.ts',
  'scripts/perf-bench.ts',
  'scripts/perf-compare.ts',
  'scripts/perf-run.ts',
  'packages/backend/src/server.ts',
  'packages/backend/tests/helpers/productionPerformanceApplication.ts',
  'packages/backend/tests/helpers/productionOverview.ts',
] as const

export interface PerfStatistics {
  readonly p50: number
  readonly p95: number
  readonly max: number
}

/** The original RFC-311 floor(q * n) definition, including its 20-sample maximum. */
export function performanceStats(samples: readonly number[]): PerfStatistics {
  if (samples.length === 0 || samples.some((n) => !Number.isFinite(n) || n < 0)) {
    throw new Error('performance samples must be nonempty, finite and nonnegative')
  }
  const sorted = [...samples].sort((a, b) => a - b)
  const at = (q: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!
  return { p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1]! }
}

export interface PerfHttpScenarioResult extends PerfStatistics {
  readonly id: (typeof PERF_HTTP_SCENARIOS)[number]['id']
  readonly legacyPath: string
  readonly path: string
  readonly samples: readonly number[]
  readonly witness: {
    readonly status: number
    readonly schemaVersion: string | number | null
    readonly itemIds: readonly string[]
    readonly nextCursor: string | null
    readonly responseDigest: string
  }
}

export interface PerfHttpReport {
  readonly version: 1
  readonly provider: 'sqlite' | 'postgresql'
  readonly sourceSha: string
  readonly executionId: string
  readonly machine: {
    readonly platform: string
    readonly arch: string
    readonly bunVersion: string
    readonly cpuModel: string
    readonly logicalCpus: number
    readonly totalMemory: number
  }
  readonly sourceDigests: Readonly<Record<string, string>>
  readonly schemaDigest: string
  readonly templateDigest: string
  readonly tier: 'small' | 'weekly' | 'full'
  readonly transport: 'hono-app-request'
  readonly rounds: number
  readonly warmups: 1
  readonly seedBefore: PerfCorpusSeedReceipt
  readonly seedAfter: PerfCorpusSeedReceipt | null
  readonly scenarios: readonly PerfHttpScenarioResult[]
  readonly complete: boolean
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

const digestPattern = /^(?:sha256:)?[a-f0-9]{64}$/
const countsKeys = Object.keys(perfCorpusCounts(PERF_CORPUS_FULL_DIMENSIONS))

function validateReport(report: PerfHttpReport, provider: PerfHttpReport['provider']): string[] {
  const errors: string[] = []
  const check = (condition: boolean, message: string): void => {
    if (!condition) errors.push(`${provider}: ${message}`)
  }
  check(
    report.version === 1 && report.provider === provider && report.complete === true,
    'incomplete or wrong provider report',
  )
  check(/^[a-f0-9]{40}$/.test(report.sourceSha), 'missing exact commit SHA')
  check(
    /^dbm_perf_restore_[a-f0-9]{32}$/.test(report.executionId),
    'missing common benchmark execution ID',
  )
  check(
    [
      report.machine.platform,
      report.machine.arch,
      report.machine.bunVersion,
      report.machine.cpuModel,
    ].every((value) => typeof value === 'string' && value.length > 0) &&
      Number.isSafeInteger(report.machine.logicalCpus) &&
      report.machine.logicalCpus > 0 &&
      Number.isSafeInteger(report.machine.totalMemory) &&
      report.machine.totalMemory > 0,
    'missing worker machine or runtime provenance',
  )
  check(report.transport === 'hono-app-request', 'changed HTTP timing transport')
  check(['full', 'weekly', 'small'].includes(report.tier), 'unknown corpus tier')
  check(
    Number.isSafeInteger(report.rounds) && report.rounds > 0 && report.warmups === 1,
    'invalid sample or warmup count',
  )
  check(
    digestPattern.test(report.schemaDigest) && digestPattern.test(report.templateDigest),
    'missing schema or common template digest',
  )
  for (const path of PERF_SOURCE_PATHS) {
    check(digestPattern.test(report.sourceDigests[path] ?? ''), `missing source digest: ${path}`)
  }
  for (const [label, seed] of [
    ['before', report.seedBefore],
    ['after', report.seedAfter],
  ] as const) {
    if (seed === null || seed === undefined) {
      check(false, `missing ${label} corpus receipt`)
      continue
    }
    check(
      seed.version === 1 && seed.matchesExpected === true,
      `${label} corpus does not match original rows`,
    )
    check(
      canonical(seed.expectedCounts) === canonical(perfCorpusCounts(seed.dimensions)),
      `${label} dimensions differ from expected counts`,
    )
    check(
      canonical(seed.expectedCounts) === canonical(seed.actualCounts),
      `${label} persisted row counts differ`,
    )
    check(
      canonical(seed.expectedDigests) === canonical(seed.actualDigests),
      `${label} persisted row digests differ`,
    )
    for (const key of countsKeys) {
      check(
        digestPattern.test(seed.actualDigests[key as keyof typeof seed.actualDigests] ?? ''),
        `${label} missing digest: ${key}`,
      )
    }
    if (report.tier === 'full') {
      check(
        canonical(seed.dimensions) === canonical(PERF_CORPUS_FULL_DIMENSIONS),
        'full report lacks original RFC-311 corpus',
      )
    }
  }
  check(
    canonical(report.seedBefore) === canonical(report.seedAfter),
    'HTTP reads changed the measured corpus',
  )
  check(
    report.scenarios.length === PERF_HTTP_SCENARIOS.length,
    'missing or duplicate HTTP scenarios',
  )
  const first = report.scenarios.find((scenario) => scenario.id === 'tasks-first')
  const firstCursor = first?.witness.nextCursor
  check(
    typeof firstCursor === 'string' && firstCursor.length > 0,
    'missing actual first-page cursor',
  )
  for (let i = 0; i < PERF_HTTP_SCENARIOS.length; i += 1) {
    const expected = PERF_HTTP_SCENARIOS[i]!
    const actual = report.scenarios[i]
    if (actual === undefined) continue
    check(
      actual.id === expected.id && actual.legacyPath === expected.legacyPath,
      `changed scenario order or identity: ${expected.id}`,
    )
    const expectedPath =
      expected.id === 'tasks-second'
        ? expected.path + encodeURIComponent(firstCursor ?? '')
        : expected.path
    check(actual.path === expectedPath, `changed request or missing cursor: ${expected.id}`)
    check(
      actual.witness.status === 200 && digestPattern.test(actual.witness.responseDigest),
      `incomplete HTTP response: ${expected.id}`,
    )
    const expectedPageSize = expected.id.startsWith('tasks-')
      ? 50
      : expected.id.startsWith('repos-')
        ? Math.min(50, report.seedBefore.dimensions.repos)
        : null
    if (expectedPageSize !== null) {
      check(actual.witness.itemIds.length === expectedPageSize, `changed page size: ${expected.id}`)
      check(
        new Set(actual.witness.itemIds).size === actual.witness.itemIds.length,
        `duplicate page IDs: ${expected.id}`,
      )
    }
    check(actual.samples.length === report.rounds, `missing raw samples: ${expected.id}`)
    const recomputed = performanceStats(actual.samples)
    check(
      actual.p50 === recomputed.p50 &&
        actual.p95 === recomputed.p95 &&
        actual.max === recomputed.max,
      `statistics differ from original quantile: ${expected.id}`,
    )
    if (expected.id === 'tasks-second') {
      const firstIds = new Set(first?.witness.itemIds)
      check(
        actual.witness.itemIds.length > 0 && !actual.witness.itemIds.some((id) => firstIds.has(id)),
        'second page is empty or overlaps first page',
      )
    }
  }
  return errors
}

export function comparePerformanceReports(sqlite: PerfHttpReport, postgresql: PerfHttpReport) {
  let errors: string[] = []
  try {
    errors = [...validateReport(sqlite, 'sqlite'), ...validateReport(postgresql, 'postgresql')]
    for (const key of [
      'sourceSha',
      'executionId',
      'machine',
      'sourceDigests',
      'schemaDigest',
      'templateDigest',
      'tier',
      'rounds',
      'warmups',
      'transport',
      'seedBefore',
    ] as const) {
      if (canonical(sqlite[key]) !== canonical(postgresql[key]))
        errors.push(`providers differ in ${key}`)
    }
    for (let i = 0; i < PERF_HTTP_SCENARIOS.length; i += 1) {
      const left = sqlite.scenarios[i]
      const right = postgresql.scenarios[i]
      if (left === undefined || right === undefined) continue
      for (const key of ['itemIds', 'schemaVersion', 'nextCursor'] as const) {
        if (canonical(left.witness[key]) !== canonical(right.witness[key]))
          errors.push(`${PERF_HTTP_SCENARIOS[i]!.id}: providers differ in ${key}`)
      }
      // Retain full response digests as evidence; overview bodies include clocks.
      // Only the stable wire projection above is compared across worker processes.
    }
  } catch (error) {
    errors.push(`malformed report: ${error instanceof Error ? error.message : String(error)}`)
  }
  const comparable = errors.length === 0
  const fullAcceptance = comparable && sqlite.tier === 'full' && sqlite.rounds === 20
  const endpoints = comparable
    ? PERF_HTTP_SCENARIOS.map((scenario, i) => {
        const left = sqlite.scenarios[i]!
        const right = postgresql.scenarios[i]!
        return {
          id: scenario.id,
          sqliteP95Ms: left.p95,
          postgresqlP95Ms: right.p95,
          postgresqlNoSlower: right.p95 <= left.p95,
          originalBudget: {
            statistic: scenario.budgetStatistic,
            strictlyBelowMs: scenario.budgetMs,
            sqlitePassed: left[scenario.budgetStatistic] < scenario.budgetMs,
            postgresqlPassed: right[scenario.budgetStatistic] < scenario.budgetMs,
          },
        }
      })
    : []
  return {
    version: 1 as const,
    comparable,
    errors,
    fullAcceptance,
    acceptancePassed: fullAcceptance && endpoints.every((endpoint) => endpoint.postgresqlNoSlower),
    endpoints,
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const flag = (name: string): string | undefined => {
    const index = args.indexOf(`--${name}`)
    return index < 0 ? undefined : args[index + 1]
  }
  const sqlitePath = flag('sqlite')
  const postgresqlPath = flag('postgresql')
  const outputPath = flag('output')
  if (!sqlitePath || !postgresqlPath || !outputPath)
    throw new Error('require --sqlite, --postgresql and --output report paths')
  const comparison = comparePerformanceReports(
    JSON.parse(readFileSync(sqlitePath, 'utf8')) as PerfHttpReport,
    JSON.parse(readFileSync(postgresqlPath, 'utf8')) as PerfHttpReport,
  )
  writeFileSync(outputPath, `${JSON.stringify(comparison, null, 2)}\n`)
  process.exitCode = (
    args.includes('--diagnostic') ? comparison.comparable : comparison.acceptancePassed
  )
    ? 0
    : 1
}
