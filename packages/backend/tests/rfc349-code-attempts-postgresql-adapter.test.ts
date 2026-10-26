import { createEpoch1HistoryQueries } from './helpers/legacyCapabilitySeed'
import { historyProjectionParity } from './helpers/model/historyOracle'
// RFC-349 — PostgreSQL AI-attempt reads preserve the bounded public projection
// and retry ordering used by the SQLite behavior oracle.

import { withNativeTransactions } from './helpers/nativeTransactions'
import { describe, expect, test } from 'bun:test'

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

function fixture(response: readonly (readonly unknown[])[]) {
  const reads: string[] = []
  const sourceRows = [response]
  const executions: Array<{ readonly sql: string; readonly parameters?: readonly unknown[] }> = []
  const run = (query: string, parameters?: readonly unknown[]) => {
    executions.push({ sql: query, parameters })
    return rows(response)
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
    generationId: 'dbg_code_attempts_pg',
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
    query: historyProjectionParity(
      'attempts',
      sourceRows,
      createEpoch1HistoryQueries(db).attempts,
      reads,
    ),
    reads,
  }
}

describe('RFC-349 PostgreSQL code attempts adapter', () => {
  test('projects attempt identity, retry counters, verdict, and runtime references', async () => {
    const fake = fixture([
      [
        'attempt-1',
        'review',
        'shard-a',
        2,
        3,
        'validated',
        'accepted',
        'session-1',
        'node-run-1',
        1_000,
        1_500,
      ],
    ])

    await expect(fake.query.forRound('round-1')).resolves.toEqual([
      {
        attemptId: 'attempt-1',
        stageName: 'review',
        shardKey: 'shard-a',
        rerunSeq: 2,
        attemptSeq: 3,
        status: 'validated',
        validationOutcome: 'accepted',
        sessionRef: 'session-1',
        nodeRunId: 'node-run-1',
        startedAt: 1_000,
        endedAt: 1_500,
      },
    ])

    expect(fake.reads).toEqual(['code_ai_attempts'])
  })
})
