// RFC-349 — PostgreSQL work-item reads preserve the bounded work-item,
// round, and stage projection used by the SQLite behavior oracle.

import { afterEach, describe, expect, test } from 'bun:test'

import { selectDatabaseSchemaProvider } from '@/db/providerSchema'
import { createCodeWorkItemProjectionQuery } from '@/modules/code-capability/application/codeMatrixQuery'
import { createPostgresqlWorkItemProjectionRead } from '@/modules/code-capability/infrastructure/postgresqlWorkItemProjectionRead'
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
    generationId: 'dbg_code_work_items_pg',
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
    query: createCodeWorkItemProjectionQuery(createPostgresqlWorkItemProjectionRead(db)),
    executions,
  }
}

afterEach(() => {
  selectDatabaseSchemaProvider('sqlite')
})

describe('RFC-349 PostgreSQL code work-item adapter', () => {
  test('projects a bounded page with round and stage history', async () => {
    const fake = fixture([
      [
        ['item-new', 'mr-review', 'mr', '42', 'idle', 3, 2_000],
        ['item-old', 'mr-review', 'mr', '41', 'idle', 2, 1_000],
      ],
      [[2]],
      [['round-1', 7, 'published', 3, 'abc123', 1_100, 1_500]],
      [['review', 1, 'ai', 'done', null, 1_200, 1_400]],
    ])

    await expect(
      fake.query.page({
        stableProjectId: 'project-1',
        capability: 'mr-review',
        limit: 1,
        roundLimit: 1,
      }),
    ).resolves.toEqual({
      items: [
        {
          workItemId: 'item-new',
          capability: 'mr-review',
          anchorKind: 'mr',
          anchorId: '42',
          status: 'idle',
          epoch: 3,
          rounds: [
            {
              roundId: 'round-1',
              roundSeq: 7,
              status: 'published',
              outcome: 'published',
              stageContractVer: 3,
              baselineSha: 'abc123',
              startedAt: 1_100,
              endedAt: 1_500,
              stages: [
                {
                  stageName: 'review',
                  stageSeq: 1,
                  kind: 'ai',
                  status: 'done',
                  error: null,
                  startedAt: 1_200,
                  endedAt: 1_400,
                },
              ],
            },
          ],
          roundsHidden: 1,
        },
      ],
      nextCursor: '2000:item-new',
    })

    expect(fake.executions).toHaveLength(4)
    expect(fake.executions[0]?.sql).toContain('from "agent_workflow"."code_work_items"')
    expect(fake.executions[1]?.sql).toContain('from "agent_workflow"."code_work_rounds"')
    expect(fake.executions[2]?.sql).toContain(
      'order by "agent_workflow"."code_work_rounds"."round_seq" desc',
    )
    expect(fake.executions[3]?.sql).toContain('from "agent_workflow"."code_round_stages"')
    expect(fake.executions.map((execution) => execution.parameters)).toEqual([
      ['project-1', 'mr-review', 2],
      ['item-new'],
      ['item-new', 1],
      ['round-1'],
    ])
  })
})
