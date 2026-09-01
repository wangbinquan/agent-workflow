// RFC-349 — memory distill monitoring uses the same Promise query contract for
// SQLite and PostgreSQL; only the infrastructure adapter sees the DB client.

import { afterEach, describe, expect, test } from 'bun:test'

import { selectDatabaseSchemaProvider } from '@/db/providerSchema'
import { composePostgresqlMemoryDistillQueries } from '@/modules/memory/composition'
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
    generationId: 'dbg_memory_distill_pg',
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
    queries: composePostgresqlMemoryDistillQueries(createPostgresqlDatabaseClient(runtime)),
    executions,
  }
}

function jobRow(id = 'job-1') {
  return [
    id,
    'debounce-1',
    'feedback',
    'feedback-1',
    'task-1',
    JSON.stringify({ agentIds: [], workflowId: null, repoId: null, includeGlobal: true }),
    'done',
    1,
    10,
    null,
    1,
    2,
    3,
    'session-1',
    'prompt',
    0,
    null,
    JSON.stringify({ snapshot: [] }),
    'en-US',
  ] as const
}

afterEach(() => {
  selectDatabaseSchemaProvider('sqlite')
})

describe('RFC-349 PostgreSQL memory distill queries', () => {
  test('projects detail through PostgreSQL without exposing its client to application code', async () => {
    const fake = fixture([
      [jobRow()],
      [jobRow()],
      [['feedback-1', 'task-1', 'use the exact provider']],
      [
        [
          'memory-1',
          'Provider invariant',
          'Never shadow SQLite',
          'global',
          null,
          'new',
          'candidate',
          null,
          5,
        ],
      ],
    ])

    await expect(fake.queries.getJobDetail('job-1')).resolves.toMatchObject({
      job: { id: 'job-1', outputLang: 'en-US' },
      sourceEvents: [
        {
          kind: 'feedback',
          id: 'feedback-1',
          summary: 'use the exact provider',
          deletedOrMissing: false,
        },
      ],
      candidates: [
        {
          memoryId: 'memory-1',
          scopeType: 'global',
          currentStatus: 'candidate',
        },
      ],
    })
    expect(fake.executions).toHaveLength(4)
    expect(fake.executions.map((entry) => entry.sql).join('\n')).toContain(
      '"agent_workflow"."memory_distill_jobs"',
    )
  })

  test('keeps attempt ordering and malformed capture behavior provider-neutral', async () => {
    const fake = fixture([
      [jobRow()],
      [
        [2, 1, 'session-2', null, 20, 'rfc043/distill-capture-failed', '{}'],
        [1, 0, 'session-1', null, 10, 'message', '{}'],
      ],
    ])

    const view = await fake.queries.getJobSessionView('job-1')
    expect(view.attempts.map((attempt) => attempt.attemptIndex)).toEqual([0, 1])
    expect(view.attempts[1]).toMatchObject({ captureFailed: true, rootSessionId: 'session-2' })
  })
})
