import { afterEach, describe, expect, test } from 'bun:test'
import type { SQLQueryBindings } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { openDb } from '../src/db/client'
import {
  createPostgresqlDatabaseRuntime,
  type PostgresqlPool,
  type SqlRows,
} from '../src/platform/persistence/postgresqlRuntime'
import { PERF_HTTP_SCENARIOS } from '../../../scripts/perf-compare'
import {
  createQueryCapture,
  profilePerformanceQueries,
  profilePostgresqlQueries,
  profileSqliteQueries,
} from '../../../scripts/perf-query-profile'
import { PERF_CORPUS_ENTRY } from '../../../scripts/perf-corpus'
import { readPerformanceCorpusReceipt, seedPerformanceCorpus } from '../../../scripts/perf-seed'
import { databaseSessionFor } from '../src/platform/persistence/databaseTransaction'
import { createProductionPerformanceApplication } from './helpers/productionPerformanceApplication'

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose()
})

function sqliteFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'rfc359-query-profile-'))
  const db = openDb({
    path: join(directory, 'test.db'),
    migrationsFolder: resolve(import.meta.dir, '../db/migrations'),
  })
  cleanup.push(() => {
    db.$client.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const profile = profileSqliteQueries(db.$client)
  cleanup.push(() => profile.stop())
  return { db, directory, sqlite: db.$client, profile }
}

function measuredReport() {
  return {
    complete: true,
    sourceSha: 'a'.repeat(40),
    executionId: 'profile-unit',
    provider: 'sqlite' as const,
    tier: 'small' as const,
    scenarios: PERF_HTTP_SCENARIOS.map((scenario) => ({
      id: scenario.id,
      legacyPath: scenario.legacyPath,
      path: scenario.path + (scenario.id === 'tasks-second' ? 'actual-first-page-cursor' : ''),
      samples: [1],
      p50: 1,
      p95: 1,
      max: 1,
      witness: {
        status: 200,
        schemaVersion: null,
        itemIds: [],
        nextCursor: null,
        responseDigest: 'unit',
      },
    })),
  }
}

describe('RFC-359 query diagnosis after completed HTTP measurement', () => {
  test('the observed write CTE gets an estimated plan while recursive reads keep actual analysis', async () => {
    // Exact statement shape from the completed full run 34196371681. Its
    // outer SELECT does not make the UPDATE inside the CTE an analyzed read.
    const marker = `WITH marked AS (
      UPDATE "agent_workflow_meta"."database_generations"
      SET first_live_write_at = $1
      WHERE generation_id = $2 AND first_live_write_at IS NULL
      RETURNING generation_id
    ) SELECT generation_id FROM marked
      UNION ALL SELECT generation_id FROM "agent_workflow_meta"."database_generations"
      WHERE generation_id = $2 LIMIT 1`
    const recursive = `WITH RECURSIVE walk(id) AS (
      SELECT 1 UNION ALL SELECT id + 1 FROM walk WHERE id < 2
    ) SELECT id, 'UPDATE is text' AS note FROM walk`
    const quoted = `/* UPDATE is a comment */ SELECT 'it''s DELETE', "update", $note$MERGE$note$`
    const capture = createQueryCapture()
    const report = { ...measuredReport(), provider: 'postgresql' as const }
    const snapshot = JSON.stringify(report)
    const seen: Array<{ sql: string; mode: string | undefined }> = []
    const result = await profilePerformanceQueries({
      report,
      token: 'unit',
      capture,
      app: {
        request() {
          capture.start(marker, [123, 'generation'])(1)
          capture.start(recursive, [])(2)
          capture.start(quoted, [])(1)
          return new Response('ok')
        },
      },
      explain: async (statement, mode?: string) => {
        seen.push({ sql: statement.sql, mode })
        return [{ node: statement.sql === marker ? 'ModifyTable' : 'Result' }]
      },
    })
    expect(result.complete).toBe(true)
    expect(seen).toHaveLength(27)
    expect(seen.slice(0, 3)).toEqual([
      { sql: marker, mode: 'plan-only' },
      { sql: recursive, mode: 'analyze' },
      { sql: quoted, mode: 'analyze' },
    ])
    expect(result.results[0]?.plans[0]).toMatchObject({
      parameters: [123, 'generation'],
      mode: 'plan-only',
      error: null,
    })
    expect(JSON.stringify(report)).toBe(snapshot)
  })

  test('native SQLite preserves bindings, getters, results and restoration', async () => {
    const { sqlite, profile } = sqliteFixture()
    const query = sqlite.query('SELECT ? AS n UNION ALL SELECT ? AS n')
    expect(query.columnNames).toEqual(['n'])
    const observed = await profile.capture.capture(async () => query.all(7, 9))
    expect(observed.value).toEqual([{ n: 7 }, { n: 9 }])
    expect(observed.statements).toHaveLength(1)
    expect(observed.statements[0]).toMatchObject({
      sql: 'SELECT ? AS n UNION ALL SELECT ? AS n',
      parameters: [7, 9],
      rows: 2,
      error: null,
    })
    expect(observed.statements[0]!.wallMs).toBeGreaterThanOrEqual(0)
    expect(observed.statements[0]!.cpuMicros).toBeGreaterThanOrEqual(0)
    profile.stop()
    expect((await profile.capture.capture(async () => query.all(7, 9))).statements).toEqual([])
    expect(
      (await profile.capture.capture(async () => sqlite.query('SELECT 3 AS n').get())).statements,
    ).toEqual([])
  })

  test('capture rejects overlap, propagates the original error, and recovers for the next request', async () => {
    const capture = createQueryCapture()
    await expect(capture.capture(() => capture.capture(async () => 1))).rejects.toThrow(
      'nested performance query capture',
    )
    const original = new Error('native failure')
    await expect(
      capture.capture(async () => {
        throw original
      }),
    ).rejects.toBe(original)
    const result = await capture.capture(async () => {
      capture.start('SELECT missing', [])(0, { error: undefined })
      return 'recovered'
    })
    expect(result.value).toBe('recovered')
    expect(result.statements[0]!.error).toBe('undefined')
  })

  test('PG mechanism wrapper preserves object/array await, reserved connection and driver errors', async () => {
    const calls: string[] = []
    const failure = new Error('native SQL failure')
    const unsafe: PostgresqlPool['unsafe'] = (sql, parameters) => {
      calls.push(sql)
      const values = parameters ?? []
      const pending: SqlRows = {
        then: (yes, no) =>
          (sql === 'SELECT bad'
            ? Promise.reject(failure)
            : Promise.resolve([{ n: values[0] }])
          ).then(yes, no),
        values: async () => [values],
      }
      return pending
    }
    const pool: PostgresqlPool = {
      unsafe,
      reserve: async () => ({
        unsafe,
        release: () => {
          calls.push('release')
        },
      }),
      close: async () => {
        calls.push('close')
      },
    }
    const runtime = createPostgresqlDatabaseRuntime({
      config: {
        provider: 'postgresql',
        urlEnv: 'PROFILE_UNIT_URL',
        poolMax: 1,
        connectTimeoutMs: 1000,
        statementTimeoutMs: 1000,
        idleTimeoutMs: 1000,
      },
      generationId: 'dbg_profile_unit',
      env: { PROFILE_UNIT_URL: 'postgresql://unit:unit@localhost/unit' },
      poolFactory: () => pool,
    })
    const profile = profilePostgresqlQueries(runtime)
    const observed = await profile.capture.capture(async () => {
      const rows = await profile.runtime.providerPool().unsafe('SELECT $1 AS n', [7])
      const connection = await profile.runtime.providerPool().reserve()
      try {
        expect(await connection.unsafe('SELECT $1 AS n', [9]).values()).toEqual([[9]])
      } finally {
        connection.release()
      }
      await expect(
        Promise.resolve(profile.runtime.providerPool().unsafe('SELECT bad')),
      ).rejects.toBe(failure)
      return rows
    })
    expect(observed.value).toEqual([{ n: 7 }])
    expect(
      observed.statements
        .filter((row) => row.sql === 'SELECT $1 AS n')
        .map((row) => [row.parameters, row.rows]),
    ).toEqual([
      [[7], 1],
      [[9], 1],
    ])
    expect(observed.statements.find((row) => row.sql === 'SELECT bad')?.error).toBe(
      'Error: native SQL failure',
    )
    await runtime.close()
    expect(calls).toContain('release')
    expect(calls.at(-1)).toBe('close')
  })

  test('uses every measured path and actual cursor; query plans and errors never change samples', async () => {
    const { sqlite, profile } = sqliteFixture()
    const report = measuredReport()
    const snapshot = JSON.stringify(report)
    const paths: string[] = []
    const result = await profilePerformanceQueries({
      report,
      token: 'unit',
      capture: profile.capture,
      app: {
        request(path) {
          paths.push(path)
          sqlite.query('SELECT ? AS n').all(7)
          sqlite.query('SELECT ? AS n').all(7)
          return new Response('ok')
        },
      },
      explain: async (statement) => {
        if (paths.length === 9) throw new Error('EXPLAIN unavailable')
        return sqlite.query(`EXPLAIN QUERY PLAN ${statement.sql}`).all(7)
      },
    })
    expect(paths).toEqual(report.scenarios.map((scenario) => scenario.path))
    expect(
      result.results.every((item) => item.statements.length === 2 && item.plans.length === 1),
    ).toBe(true)
    expect(result.results[0]!.plans[0]!.plan).toBeArray()
    expect(result.results[8]!.plans[0]!.error).toBe('Error: EXPLAIN unavailable')
    expect(result.complete).toBe(false)
    expect(JSON.stringify(report)).toBe(snapshot)
  })

  test('rejects incomplete or reordered reports before any request', async () => {
    const capture = createQueryCapture()
    let requests = 0
    for (const report of [
      { ...measuredReport(), complete: false },
      { ...measuredReport(), scenarios: measuredReport().scenarios.slice(1) },
      { ...measuredReport(), scenarios: measuredReport().scenarios.reverse() },
    ]) {
      await expect(
        profilePerformanceQueries({
          report,
          token: 'unit',
          capture,
          app: {
            request() {
              requests += 1
              return new Response('ok')
            },
          },
          explain: async () => [],
        }),
      ).rejects.toThrow('complete ordered HTTP report')
    }
    expect(requests).toBe(0)
  })

  test('traces actual HTTP owners and their native plans on a tiny real corpus without changing rows', async () => {
    const { db, directory, sqlite, profile } = sqliteFixture()
    const dimensions = { tasks: 123, runsPerTask: 2, events: 11, deliveries: 7, repos: 3 }
    const before = await seedPerformanceCorpus({ db, session: databaseSessionFor(db), dimensions })
    const app = await createProductionPerformanceApplication({
      db,
      appHome: directory,
      configPath: join(directory, 'config.json'),
      daemonToken: PERF_CORPUS_ENTRY.bearerToken,
    })
    const first = await app.request('/api/task-catalog?limit=50', {
      headers: { Authorization: `Bearer ${PERF_CORPUS_ENTRY.bearerToken}` },
    })
    const page = (await first.json()) as { nextCursor: string }
    expect(first.status).toBe(200)
    expect(page.nextCursor).toBeString()
    const report = measuredReport()
    report.scenarios[1]!.path = `/api/task-catalog?limit=50&cursor=${encodeURIComponent(page.nextCursor)}`
    const traced = await profilePerformanceQueries({
      app,
      token: PERF_CORPUS_ENTRY.bearerToken,
      report,
      capture: profile.capture,
      explain: async (statement) =>
        sqlite
          .query(`EXPLAIN QUERY PLAN ${statement.sql}`)
          .all(...(statement.parameters as SQLQueryBindings[])),
    })
    expect(traced.complete).toBe(true)
    expect(traced.results).toHaveLength(9)
    expect(
      traced.results.every(
        (item) => item.value.status === 200 && item.statements.length > 0 && item.plans.length > 0,
      ),
    ).toBe(true)
    expect(
      traced.results.every((item) => item.plans.every((plan) => Array.isArray(plan.plan))),
    ).toBe(true)
    expect(await readPerformanceCorpusReceipt(db, dimensions)).toEqual(before)
  })
})
