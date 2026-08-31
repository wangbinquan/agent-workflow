// RFC-349 — the repository capability matrix reads provider-owned facts while
// application code remains the only owner of readiness and repair derivation.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Hono, type MiddlewareHandler } from 'hono'

import { buildActor } from '@/auth/actor'
import { selectDatabaseSchemaProvider } from '@/db/providerSchema'
import { createCodeMatrixQuery } from '@/modules/code-capability/application/codeMatrixQuery'
import { composePostgresqlCodeHistoryQueries } from '@/modules/code-capability/composition/historyQueries'
import { createPostgresqlCapabilityMatrixRead } from '@/modules/code-capability/infrastructure/postgresqlCapabilityMatrixRead'
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

const REPO = 'repo-1'

function rows(values: readonly (readonly unknown[])[]): SqlRows {
  return Object.assign(Promise.resolve([] as readonly Record<string, unknown>[]), {
    async values() {
      return values
    },
  })
}

function fixture(responses: Array<readonly (readonly unknown[])[]>) {
  const executions: Array<{ readonly sql: string; readonly parameters?: readonly unknown[] }> = []
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
    generationId: 'dbg_code_matrix_pg',
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
  return { db: createPostgresqlDatabaseClient(runtime), executions }
}

function appWithHistory(history: ReturnType<typeof composePostgresqlCodeHistoryQueries>): Hono {
  const app = new Hono()
  const actor = buildActor({
    user: {
      id: 'rfc349-code-matrix-user',
      username: 'rfc349-code-matrix-user',
      displayName: 'RFC-349 Code Matrix User',
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

describe('RFC-349 PostgreSQL code capability matrix adapter', () => {
  test('the injected HTTP matrix derives ready from bounded PostgreSQL facts', async () => {
    const fake = fixture([
      [[REPO, 'mr-review', 'template-1', true]],
      [['endpoint-1', 'gitlab']],
      [['template-1', JSON.stringify({ reviewer: 'agent-1' })]],
      [
        [
          'trigger-1',
          'mr-review',
          JSON.stringify({ kind: 'paths', paths: [REPO] }),
          JSON.stringify(['mr_opened']),
        ],
      ],
      [['agent-1']],
    ])
    const app = appWithHistory(composePostgresqlCodeHistoryQueries(fake.db))

    const response = await app.request(`/api/code/matrix/${REPO}`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      rows: [
        {
          repoId: REPO,
          capability: 'mr-review',
          enabled: true,
          readiness: 'ready',
          issues: [],
          repairActions: [],
          templateId: 'template-1',
        },
      ],
    })

    expect(fake.executions).toHaveLength(5)
    const sql = fake.executions.map((execution) => execution.sql).join('\n')
    for (const table of [
      'repo_capability_config',
      'webhook_endpoints',
      'capability_templates',
      'webhook_triggers',
      'agents',
    ]) {
      expect(sql).toContain(`"agent_workflow"."${table}"`)
    }
  })

  test('missing PostgreSQL prerequisites remain actionable rather than throwing', async () => {
    const fake = fixture([[[REPO, 'mr-review', null, true]], []])
    const query = createCodeMatrixQuery(createPostgresqlCapabilityMatrixRead(fake.db))

    const [row] = await query.forRepo(REPO)
    expect(row?.readiness).toBe('misconfigured')
    expect(row?.issues.map((issue) => issue.code)).toEqual([
      'no-binding',
      'no-trigger',
      'code-host-unconfigured',
      'agent-not-visible',
    ])
    expect(row?.repairActions.map((action) => action.code)).toEqual(
      row?.issues.map((issue) => issue.code),
    )
    expect(fake.executions).toHaveLength(2)
  })
})
