import type { CodeHistoryQueryReader } from '@/modules/code-capability/application/ports/historyQueryIndex'
import { createAgentExecutionQueries } from '@/modules/resource-catalog/infrastructure/executionResourceQueries'
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
import { mountCodeRoutes } from '@/modules/code-capability/composition/routes'
import { resetRouteMetaRegistry } from '@/routes/registry'
import { errorHandler } from '@/platform/errors/domainErrors'
import { persistenceSchemaBinding } from '@/bootstrap/persistenceSchema'

const CODE_ROUTE_SOURCE = resolve(
  import.meta.dir,
  '..',
  'src',
  'modules',
  'code-capability',
  'inbound',
  'http',
  'codeRoutes.ts',
)
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
  const readOperations: string[] = []
  const now = Date.now()
  const unexpected = async (): Promise<never> => {
    throw new Error('unexpected history operation')
  }
  // This is the query port consumed by the PostgreSQL composition. The durable
  // archive-to-SQL projection has separate dual-provider RFC-602 behavior tests.
  const reader: CodeHistoryQueryReader = {
    rows: unexpected,
    find: unexpected,
    workItems: {
      async readPage() {
        readOperations.push('workItems.readPage')
        return {
          items: [
            {
              workItemId: 'item',
              capability: 'mr-review',
              anchorKind: 'mr',
              anchorId: '42',
              status: 'idle',
              epoch: 1,
              roundsHidden: 0,
              rounds: [
                {
                  roundId: 'round-1',
                  roundSeq: 1,
                  status: 'published',
                  outcome: 'published',
                  stageContractVer: 1,
                  baselineSha: 'base',
                  startedAt: now,
                  endedAt: now,
                  stages: [
                    {
                      stageName: 'review',
                      stageSeq: 1,
                      kind: 'ai',
                      status: 'done',
                      error: null,
                      startedAt: now,
                      endedAt: now,
                    },
                  ],
                },
              ],
            },
          ],
          nextCursor: null,
        }
      },
    },
    attempts: {
      async load(roundId, limit) {
        expect({ roundId, limit }).toEqual({ roundId: 'round-1', limit: 200 })
        readOperations.push('attempts.load')
        return [
          {
            attemptId: 'attempt',
            stageName: 'review',
            shardKey: '',
            rerunSeq: 0,
            attemptSeq: 1,
            status: 'validated',
            validationOutcome: 'accepted',
            sessionRef: 'session',
            nodeRunId: 'run',
            startedAt: now,
            endedAt: now,
          },
        ]
      },
    },
    deliveries: {
      async recent(input) {
        expect(input.stableProjectId).toBe('project-1')
        readOperations.push('deliveries.recent')
        return [
          {
            id: 'delivery',
            correlationId: 'correlation',
            capability: 'mr-review',
            step: 'routed',
            outcome: 'ok',
            reason: null,
            queuedAt: null,
            queuePosition: null,
            waitingOn: null,
            roundId: 'round-1',
            isProbe: false,
            createdAt: now,
            updatedAt: now,
          },
        ]
      },
      byCorrelation: unexpected,
      failures: unexpected,
    },
    metrics: {
      async loadSince() {
        readOperations.push('metrics.loadSince')
        return {
          findings: [{ capability: 'mr-review', resolvedAt: now, codeChangedAt: now, n: 1 }],
          rounds: [{ capability: 'mr-review', outcome: 'published', endedAt: now, n: 1 }],
        }
      },
    },
  }
  return {
    history: composeCodeHistoryQueries(
      createPostgresqlDatabaseClient(runtime, { liveSchema: persistenceSchemaBinding }),
      createAgentExecutionQueries(
        createPostgresqlDatabaseClient(runtime, { liveSchema: persistenceSchemaBinding }),
      ),
      reader,
    ),
    executions,
    readOperations,
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
    expect(fixture.readOperations.splice(0)).toEqual(['workItems.readPage'])

    const attempts = await app.request('/api/code/rounds/round-1/attempts')
    expect(attempts.status).toBe(200)
    expect(await attempts.json()).toMatchObject({
      attempts: [{ attemptId: 'attempt', nodeRunId: 'run', validationOutcome: 'accepted' }],
    })
    expect(fixture.readOperations.splice(0)).toEqual(['attempts.load'])

    const deliveries = await app.request('/api/code/deliveries?projectId=project-1')
    expect(deliveries.status).toBe(200)
    expect(await deliveries.json()).toMatchObject({
      deliveries: [{ id: 'delivery', roundId: 'round-1', outcome: 'ok' }],
    })
    expect(fixture.readOperations.splice(0)).toEqual(['deliveries.recent'])

    const metrics = await app.request('/api/code/metrics?windowMs=60000')
    expect(metrics.status).toBe(200)
    expect(await metrics.json()).toMatchObject({
      windowMs: 60000,
      adoption: [{ capability: 'mr-review', published: 1, adopted: 1 }],
      runs: [{ capability: 'mr-review', rounds: 1, published: 1 }],
    })
    expect(fixture.readOperations.splice(0)).toEqual(['metrics.loadSince'])

    expect(fixture.executions).toEqual([])
  })
})
