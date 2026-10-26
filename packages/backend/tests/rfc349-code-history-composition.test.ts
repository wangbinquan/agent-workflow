import type { CodeHistoryReader } from '@/modules/code-capability/application/ports/historyReader'
import { createAgentExecutionQueries } from '@/modules/resource-catalog/public/queries'
// RFC-349 — the code-history HTTP surface consumes one provider-neutral
// aggregate. A PostgreSQL composition must reach all four history endpoints
// without the route selecting or reopening SQLite.

import { withNativeTransactions } from './helpers/nativeTransactions'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Hono, type MiddlewareHandler } from 'hono'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { buildActor } from '@/auth/actor'
import { composeCodeHistoryQueries } from '@/modules/code-capability/composition/historyQueries'
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
const APPLICATION_SOURCE = resolve(
  import.meta.dir,
  '..',
  'src',
  'bootstrap',
  'daemonApplication.ts',
)

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
  const connection: PostgresqlReservedConnection = withNativeTransactions({
    unsafe: run,
    release() {},
  })
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
  const readTables: string[] = []
  const now = Date.now()
  const retained: Record<string, object[]> = {
    code_work_items: [
      {
        id: 'item',
        stable_project_id: 'project-1',
        capability: 'mr-review',
        anchor_kind: 'mr',
        anchor_id: '42',
        status: 'idle',
        epoch: 1,
        created_at: now,
      },
    ],
    code_work_rounds: [
      {
        id: 'round-1',
        work_item_id: 'item',
        round_seq: 1,
        outcome: 'published',
        stage_contract_ver: 1,
        baseline_sha: 'base',
        started_at: now,
        ended_at: now,
      },
    ],
    code_round_stages: [
      {
        round_id: 'round-1',
        stage_name: 'review',
        stage_seq: 1,
        stage_kind: 'ai',
        status: 'done',
        error: null,
        started_at: now,
        ended_at: now,
      },
    ],
    code_ai_attempts: [
      {
        id: 'attempt',
        round_id: 'round-1',
        stage_name: 'review',
        shard_key: null,
        rerun_seq: 0,
        attempt_seq: 1,
        status: 'validated',
        validation_outcome: 'accepted',
        session_ref: 'session',
        node_run_id: 'run',
        started_at: now,
        ended_at: now,
      },
    ],
    code_trigger_deliveries: [
      {
        id: 'delivery',
        stable_project_id: 'project-1',
        correlation_id: 'correlation',
        capability: 'mr-review',
        step: 'routed',
        outcome: 'ok',
        reason: null,
        queued_at: null,
        queue_position: null,
        waiting_on: null,
        round_id: 'round-1',
        is_probe: false,
        created_at: now,
        updated_at: now,
      },
    ],
    code_findings: [
      {
        id: 'finding',
        capability: 'mr-review',
        external_id: 'published',
        created_at: now,
        resolved_at: now,
        code_changed_at: now,
      },
    ],
  }
  const reader: CodeHistoryReader = {
    async rows(table) {
      readTables.push(table)
      return (retained[table] ?? []) as never
    },
    async find() {
      throw new Error('unexpected history index lookup')
    },
  }
  return {
    history: composeCodeHistoryQueries(
      createPostgresqlDatabaseClient(runtime),
      createAgentExecutionQueries(createPostgresqlDatabaseClient(runtime)),
      reader,
    ),
    executions,
    readTables,
  }
}

function appWithHistory(history: ReturnType<typeof composeCodeHistoryQueries>): Hono {
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
  resetRouteMetaRegistry()
})

describe('RFC-349 code-history composition', () => {
  test('route mounting cannot reopen SQLite after bootstrap selected a provider', () => {
    const routeSource = readFileSync(CODE_ROUTE_SOURCE, 'utf8')
    const serverSource = readFileSync(SERVER_SOURCE, 'utf8')
    const applicationSource = readFileSync(APPLICATION_SOURCE, 'utf8')

    expect(routeSource).not.toContain('sqliteCodeHistoryFallback')
    expect(routeSource).not.toContain('deps.db')
    expect(
      readFileSync(resolve(import.meta.dir, '../src/bootstrap/daemonHttpComposition.ts'), 'utf8'),
    ).toContain('createAgentExecutionQueries(input.db)')
    expect(serverSource).toContain('mountCodeRoutes(app, input.code.history)')
    expect(applicationSource).not.toContain('composeCodeHistoryQueries(')
    expect(applicationSource).toContain('composeProviderAppComposition({')
  })

  test('one PostgreSQL aggregate drives all four HTTP history projections', async () => {
    const fixture = postgresqlHistoryFixture()
    const app = appWithHistory(fixture.history)

    const workItems = await app.request('/api/code/work-items')
    expect(workItems.status).toBe(200)
    expect(await workItems.json()).toMatchObject({
      items: [
        { workItemId: 'item', rounds: [{ roundId: 'round-1', stages: [{ stageName: 'review' }] }] },
      ],
      nextCursor: null,
    })
    expect(fixture.readTables.splice(0)).toEqual([
      'code_work_items',
      'code_work_rounds',
      'code_round_stages',
    ])

    const attempts = await app.request('/api/code/rounds/round-1/attempts')
    expect(attempts.status).toBe(200)
    expect(await attempts.json()).toMatchObject({
      attempts: [{ attemptId: 'attempt', nodeRunId: 'run', validationOutcome: 'accepted' }],
    })
    expect(fixture.readTables.splice(0)).toEqual(['code_ai_attempts'])

    const deliveries = await app.request('/api/code/deliveries?projectId=project-1')
    expect(deliveries.status).toBe(200)
    expect(await deliveries.json()).toMatchObject({
      deliveries: [{ id: 'delivery', roundId: 'round-1', outcome: 'ok' }],
    })
    expect(fixture.readTables.splice(0)).toEqual(['code_trigger_deliveries'])

    const metrics = await app.request('/api/code/metrics?windowMs=60000')
    expect(metrics.status).toBe(200)
    expect(await metrics.json()).toMatchObject({
      windowMs: 60000,
      adoption: [{ capability: 'mr-review', published: 1, adopted: 1 }],
      runs: [{ capability: 'mr-review', rounds: 1, published: 1 }],
    })
    expect(fixture.readTables.splice(0)).toEqual([
      'code_findings',
      'code_work_items',
      'code_work_rounds',
    ])

    expect(fixture.executions).toEqual([])
  })
})
