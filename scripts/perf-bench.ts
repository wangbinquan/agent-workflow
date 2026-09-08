// RFC-311 / RFC-359 AC11 — the original in-process HTTP timing boundary.
// Seed and construct the real application before timing. Archive is a separate,
// mutating phase after every HTTP sample; it is never a tenth P95 endpoint.
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { openDb, type DbClient } from '../packages/backend/src/db/client'
import type { PostgresqlDatabaseClient } from '../packages/backend/src/platform/persistence/postgresqlDatabaseClient'
import { createPostgresqlEventsArchiveStore } from '../packages/backend/src/platform/persistence/postgresqlEventsArchive'
import {
  archiveEventsWithStore,
  createSqliteEventsArchiveStore,
} from '../packages/backend/src/services/eventsArchive'
import { createProductionPerformanceApplication } from '../packages/backend/tests/helpers/productionPerformanceApplication'
import { PERF_CORPUS_ENTRY } from './perf-corpus'
import { PERF_HTTP_SCENARIOS, performanceStats, type PerfHttpScenarioResult } from './perf-compare'

export async function measurePerformanceHttp(input: {
  readonly app: Awaited<ReturnType<typeof createProductionPerformanceApplication>>
  readonly token: string
  readonly rounds: number
  readonly only?: string
  readonly onScenario?: (result: PerfHttpScenarioResult) => void | Promise<void>
}): Promise<PerfHttpScenarioResult[]> {
  if (!Number.isSafeInteger(input.rounds) || input.rounds < 1)
    throw new Error('rounds must be a positive integer')
  const headers = { Authorization: `Bearer ${input.token}` }
  const timed = async (path: string) => {
    const started = performance.now()
    const response = await input.app.request(path, { headers })
    if (response.status !== 200)
      throw new Error(`${path} -> ${response.status}: ${await response.text()}`)
    const bytes = await response.arrayBuffer()
    const milliseconds = performance.now() - started
    return { bytes, milliseconds, status: response.status }
  }
  const results: PerfHttpScenarioResult[] = []
  let nextCursor: string | null = null
  for (const scenario of PERF_HTTP_SCENARIOS) {
    if (input.only !== undefined && !`${scenario.id} ${scenario.label}`.includes(input.only))
      continue
    let path: string = scenario.path
    if (scenario.id === 'tasks-second') {
      // Even a --only second-page diagnostic uses the actual first HTTP response.
      if (nextCursor === null) {
        const first = await timed(PERF_HTTP_SCENARIOS[0].path)
        nextCursor = (
          JSON.parse(new TextDecoder().decode(first.bytes)) as { nextCursor: string | null }
        ).nextCursor
      }
      if (typeof nextCursor !== 'string' || nextCursor.length === 0)
        throw new Error('performance corpus has no second task page')
      path += encodeURIComponent(nextCursor)
    }
    await timed(path) // Exactly one excluded warmup, as in RFC-311.
    const samples: number[] = []
    let last: Awaited<ReturnType<typeof timed>> | undefined
    for (let i = 0; i < input.rounds; i += 1) {
      last = await timed(path)
      samples.push(last.milliseconds)
    }
    if (last === undefined) throw new Error('missing performance samples')
    const body = JSON.parse(new TextDecoder().decode(last.bytes)) as {
      schemaVersion?: string | number
      items?: { id: string }[]
      nextCursor?: string | null
    }
    if (scenario.id === 'tasks-first') nextCursor = body.nextCursor ?? null
    const result: PerfHttpScenarioResult = {
      id: scenario.id,
      legacyPath: scenario.legacyPath,
      path,
      samples,
      ...performanceStats(samples),
      witness: {
        status: last.status,
        schemaVersion: body.schemaVersion ?? null,
        itemIds: body.items?.map((item) => item.id) ?? [],
        nextCursor: body.nextCursor ?? null,
        responseDigest: createHash('sha256').update(new Uint8Array(last.bytes)).digest('hex'),
      },
    }
    results.push(result)
    await input.onScenario?.(result)
  }
  return results
}

export async function measurePerformanceArchive(
  db: DbClient | PostgresqlDatabaseClient,
  logDir: string,
) {
  const started = performance.now()
  const store =
    '$provider' in db ? createPostgresqlEventsArchiveStore(db) : createSqliteEventsArchiveStore(db)
  const result = await archiveEventsWithStore(
    store,
    {
      eventsArchiveThresholds: {
        perNodeRunRows: 50_000,
        globalRows: 1_000_000,
        perNodeRunBytes: 8 * 1024 * 1024,
        globalBytes: 256 * 1024 * 1024,
      },
    },
    logDir,
  )
  return { milliseconds: performance.now() - started, ...result }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const flag = (name: string): string | undefined => {
    const index = args.indexOf(`--${name}`)
    return index < 0 ? undefined : args[index + 1]
  }
  const path = resolve(flag('db') ?? '/tmp/aw-perf/agent-workflow.db')
  const rounds = Number(flag('rounds') ?? 20)
  const temp = mkdtempSync(join(tmpdir(), 'aw-perf-bench-'))
  const appHome = join(temp, 'home')
  mkdirSync(appHome, { recursive: true })
  process.env.AGENT_WORKFLOW_HOME = appHome
  const db = openDb({
    path,
    migrationsFolder: resolve(import.meta.dir, '../packages/backend/db/migrations'),
  })
  try {
    const app = await createProductionPerformanceApplication({
      db,
      appHome,
      configPath: join(temp, 'config.json'),
      daemonToken: PERF_CORPUS_ENTRY.bearerToken,
    })
    await measurePerformanceHttp({
      app,
      token: PERF_CORPUS_ENTRY.bearerToken,
      rounds,
      only: flag('only'),
      onScenario: (result) => {
        console.log(
          `${result.id.padEnd(24)} p50=${result.p50.toFixed(1)}ms p95=${result.p95.toFixed(1)}ms max=${result.max.toFixed(1)}ms (n=${rounds})`,
        )
      },
    })
    console.log(
      '[perf-bench] archive phase',
      await measurePerformanceArchive(db, join(temp, 'logs')),
    )
  } finally {
    db.$client.close()
  }
}
