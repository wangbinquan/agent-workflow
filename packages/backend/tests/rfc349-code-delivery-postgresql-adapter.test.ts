// RFC-349 — PostgreSQL delivery-chain reads answer the same three bounded
// troubleshooting questions as the SQLite adapter.

import { afterEach, describe, expect, test } from 'bun:test'

import { selectDatabaseSchemaProvider } from '@/db/providerSchema'
import { createCodeDeliveryChainQuery } from '@/modules/code-capability/application/codeMatrixQuery'
import { createPostgresqlDeliveryChainRead } from '@/modules/code-capability/infrastructure/postgresqlDeliveryChain'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  PostgresqlDatabaseRuntime,
  PostgresqlPool,
  PostgresqlReservedConnection,
  SqlRows,
} from '@/platform/persistence/postgresqlRuntime'

function rows(values: readonly (readonly unknown[])[]): SqlRows {
  return Object.assign(Promise.resolve([] as readonly Record<string, unknown>[]), {
    async values() {
      return values
    },
  })
}

function fixture(responses: Array<readonly (readonly unknown[])[]>) {
  const executions: Array<{ readonly sql: string; readonly parameters?: readonly unknown[] }> = []
  const run = (query: string, parameters?: readonly unknown[]) => {
    executions.push({ sql: query, parameters })
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
    generationId: 'dbg_code_delivery_pg',
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
  const db = createPostgresqlDatabaseClient(runtime)
  return {
    query: createCodeDeliveryChainQuery(createPostgresqlDeliveryChainRead(db)),
    executions,
  }
}

afterEach(() => {
  selectDatabaseSchemaProvider('sqlite')
})

describe('RFC-349 PostgreSQL code delivery adapter', () => {
  test('answers project, correlation, and failure reads through the closed port', async () => {
    const fake = fixture([
      [
        [
          'delivery-project',
          'correlation-project',
          'mr-review',
          'queued',
          'failed',
          'merge-request lease held',
          1_100,
          2,
          'merge-request-lease',
          'round-1',
          true,
          1_000,
          1_200,
        ],
      ],
      [
        [
          'delivery-correlation',
          'correlation-1',
          null,
          'received',
          'ok',
          null,
          null,
          null,
          null,
          null,
          false,
          2_000,
          2_000,
        ],
      ],
      [
        [
          'delivery-failed',
          'correlation-failed',
          'ci-fix',
          'routed',
          'failed',
          'route failed',
          null,
          null,
          null,
          null,
          false,
          3_000,
          3_100,
        ],
      ],
    ])

    await expect(
      fake.query.forProject({ stableProjectId: 'project-1', limit: 2 }),
    ).resolves.toEqual([
      {
        id: 'delivery-project',
        correlationId: 'correlation-project',
        capability: 'mr-review',
        step: 'queued',
        outcome: 'failed',
        reason: 'merge-request lease held',
        queuedAt: 1_100,
        queuePosition: 2,
        waitingOn: 'merge-request-lease',
        roundId: 'round-1',
        isProbe: true,
        createdAt: 1_000,
        updatedAt: 1_200,
      },
    ])
    await expect(fake.query.forCorrelation('correlation-1')).resolves.toMatchObject([
      { id: 'delivery-correlation', outcome: 'ok', isProbe: false },
    ])
    await expect(
      fake.query.failures({ stableProjectId: 'project-1', limit: 5 }),
    ).resolves.toMatchObject([{ id: 'delivery-failed', outcome: 'failed' }])

    expect(fake.executions).toHaveLength(3)
    for (const execution of fake.executions) {
      expect(execution.sql).toContain('"agent_workflow"."code_trigger_deliveries"')
    }
    expect(fake.executions.map((execution) => execution.parameters)).toEqual([
      ['project-1', 2],
      ['correlation-1'],
      ['failed', 'project-1', 5],
    ])
  })
})
