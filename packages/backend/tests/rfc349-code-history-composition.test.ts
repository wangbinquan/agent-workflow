// RFC-349 — the code-history HTTP surface consumes one provider-neutral
// aggregate. A PostgreSQL composition must reach all four history endpoints
// without the route selecting or reopening SQLite.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Hono, type MiddlewareHandler } from 'hono'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { buildActor } from '@/auth/actor'
import { selectDatabaseSchemaProvider } from '@/db/providerSchema'
import { composePostgresqlCodeHistoryQueries } from '@/modules/code-capability/composition/historyQueries'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  PostgresqlDatabaseRuntime,
  PostgresqlPool,
  PostgresqlReservedConnection,
  SqlRows,
} from '@/platform/persistence/postgresqlRuntime'
import { mountCodeRoutes } from '@/routes/code'
import { resetRouteMetaRegistry } from '@/routes/registry'
import { errorHandler } from '@/util/errors'

const CODE_ROUTE_SOURCE = resolve(import.meta.dir, '..', 'src', 'routes', 'code.ts')
const SERVER_SOURCE = resolve(import.meta.dir, '..', 'src', 'server.ts')
const START_SOURCE = resolve(import.meta.dir, '..', 'src', 'cli', 'start.ts')

function rows(values: readonly (readonly unknown[])[]): SqlRows {
  return Object.assign(Promise.resolve([] as readonly Record<string, unknown>[]), {
    async values() {
      return values
    },
  })
}

function postgresqlHistoryFixture() {
  const executions: Array<{ readonly sql: string; readonly parameters?: readonly unknown[] }> = []
  const responses: Array<readonly (readonly unknown[])[]> = [[], [], [], [], []]
  const run = (sql: string, parameters?: readonly unknown[]) => {
    executions.push({ sql, parameters })
    return rows(responses.shift() ?? [])
  }
  const connection: PostgresqlReservedConnection = { unsafe: run, release() {} }
  const pool: PostgresqlPool = {
    async reserve() {
      return connection
    },
    unsafe: run,
    async close() {},
  }
  const runtime: PostgresqlDatabaseRuntime = {
    provider: 'postgresql',
    generationId: 'dbg_code_history_pg',
    async health() {
      throw new Error('not used')
    },
    async readiness() {
      throw new Error('not used')
    },
    async acquireMigrationAdvisoryLock() {
      throw new Error('not used')
    },
    providerPool: () => pool,
    async close() {},
  }
  return {
    history: composePostgresqlCodeHistoryQueries(createPostgresqlDatabaseClient(runtime)),
    executions,
  }
}

function appWithHistory(history: ReturnType<typeof composePostgresqlCodeHistoryQueries>): Hono {
  const app = new Hono()
  const actor = buildActor({
    user: {
      id: 'rfc349-code-history-user',
      username: 'rfc349-code-history-user',
      displayName: 'RFC-349 Code History User',
      role: 'admin',
      status: 'active',
    },
    source: 'daemon',
  })
  const injectActor: MiddlewareHandler = async (context, next) => {
    context.set('actor', actor)
    await next()
  }
  app.use('*', injectActor)
  app.onError(errorHandler)
  mountCodeRoutes(app, history)
  return app
}

beforeEach(() => {
  resetRouteMetaRegistry()
})

afterEach(() => {
  selectDatabaseSchemaProvider('sqlite')
  resetRouteMetaRegistry()
})

describe('RFC-349 code-history composition', () => {
  test('route mounting cannot reopen SQLite after bootstrap selected a provider', () => {
    const routeSource = readFileSync(CODE_ROUTE_SOURCE, 'utf8')
    const serverSource = readFileSync(SERVER_SOURCE, 'utf8')
    const startSource = readFileSync(START_SOURCE, 'utf8')

    expect(routeSource).not.toContain('sqliteCodeHistoryFallback')
    expect(routeSource).not.toContain('deps.db')
    expect(serverSource).toContain(
      'codeHistoryQueries: deps.codeHistoryQueries ?? composeSqliteCodeHistoryQueries(deps.db)',
    )
    expect(serverSource).toContain('mountCodeRoutes(app, deps.codeHistoryQueries)')
    expect(startSource).toContain('const codeHistoryQueries = composeSqliteCodeHistoryQueries(db)')
    expect(startSource).toContain('codeHistoryQueries,')
  })

  test('one PostgreSQL aggregate drives all four HTTP history projections', async () => {
    const fixture = postgresqlHistoryFixture()
    const app = appWithHistory(fixture.history)

    const workItems = await app.request('/api/code/work-items')
    expect(workItems.status).toBe(200)
    expect(await workItems.json()).toEqual({ items: [], nextCursor: null })

    const attempts = await app.request('/api/code/rounds/round-1/attempts')
    expect(attempts.status).toBe(200)
    expect(await attempts.json()).toEqual({ attempts: [] })

    const deliveries = await app.request('/api/code/deliveries?projectId=project-1')
    expect(deliveries.status).toBe(200)
    expect(await deliveries.json()).toEqual({ deliveries: [] })

    const metrics = await app.request('/api/code/metrics?windowMs=1000')
    expect(metrics.status).toBe(200)
    expect(await metrics.json()).toEqual({ windowMs: 1000, adoption: [], runs: [] })

    expect(fixture.executions).toHaveLength(5)
    const sql = fixture.executions.map((execution) => execution.sql).join('\n')
    for (const table of [
      'code_work_items',
      'code_ai_attempts',
      'code_trigger_deliveries',
      'code_findings',
      'code_work_rounds',
    ]) {
      expect(sql).toContain(`"agent_workflow"."${table}"`)
    }
  })
})
