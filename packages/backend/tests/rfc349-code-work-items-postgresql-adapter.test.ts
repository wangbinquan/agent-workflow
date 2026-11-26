import { createEpoch1HistoryQueries } from './helpers/legacyCapabilitySeed'
import { historyProjectionParity } from './helpers/model/historyOracle'
// RFC-349 — PostgreSQL work-item reads preserve the bounded work-item,
// round, and stage projection used by the SQLite behavior oracle.

import { withNativeTransactions } from './helpers/nativeTransactions'
import { expect, test } from 'bun:test'
import { describeEachProvider, type ProviderDatabaseHarness } from './helpers/eachProvider'

import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  PostgresqlDatabaseRuntime,
  PostgresqlPool,
  PostgresqlReservedConnection,
  SqlRows,
} from '@/platform/persistence/postgresqlRuntime'
import { persistenceSchemaBinding } from '@/bootstrap/persistenceSchema'

function rows(values: readonly (readonly unknown[])[]): SqlRows {
  return Object.assign(Promise.resolve([] as readonly Record<string, unknown>[]), {
    async values() {
      return values
    },
  })
}

function fixture(
  harness: ProviderDatabaseHarness,
  responses: Array<readonly (readonly unknown[])[]>,
) {
  const reads: string[] = []
  const sourceRows = [...responses]
  const executions: Array<{ readonly sql: string; readonly parameters?: readonly unknown[] }> = []
  const run = (query: string, parameters?: readonly unknown[]) => {
    executions.push({ sql: query, parameters })
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
  const db = createPostgresqlDatabaseClient(runtime, { liveSchema: persistenceSchemaBinding })
  return {
    query: historyProjectionParity(
      'workItems',
      sourceRows,
      createEpoch1HistoryQueries(db).workItems,
      harness,
      reads,
    ),
    reads,
  }
}

describeEachProvider('RFC-349 durable code work-item adapter parity', (harness) => {
  test('projects a bounded page with round and stage history', async () => {
    const fake = fixture(harness, [
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

    expect(fake.reads).toEqual([
      'code_history_query_work_items',
      'code_history_query_rounds',
      'code_history_query_stages',
    ])
  })
})
