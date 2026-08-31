// RFC-349 — PostgreSQL AI-attempt reads preserve the bounded public projection
// and retry ordering used by the SQLite behavior oracle.

import { afterEach, describe, expect, test } from 'bun:test'

import { selectDatabaseSchemaProvider } from '@/db/providerSchema'
import {
  ATTEMPTS_PER_ROUND,
  createCodeRoundAttemptsQuery,
} from '@/modules/code-capability/application/codeMatrixQuery'
import { createPostgresqlRoundAttemptsRead } from '@/modules/code-capability/infrastructure/postgresqlRoundAttemptsRead'
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
  const executions: Array<{ readonly sql: string; readonly parameters?: readonly unknown[] }> = []
  const run = (query: string, parameters?: readonly unknown[]) => {
    executions.push({ sql: query, parameters })
    return rows(response)
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
    query: createCodeRoundAttemptsQuery(createPostgresqlRoundAttemptsRead(db)),
    executions,
  }
}

afterEach(() => {
  selectDatabaseSchemaProvider('sqlite')
})

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

    expect(fake.executions).toHaveLength(1)
    expect(fake.executions[0]?.sql).toContain('from "agent_workflow"."code_ai_attempts"')
    expect(fake.executions[0]?.sql).toContain(
      'order by "agent_workflow"."code_ai_attempts"."started_at"',
    )
    expect(fake.executions[0]?.parameters).toEqual(['round-1', ATTEMPTS_PER_ROUND])
  })
})
