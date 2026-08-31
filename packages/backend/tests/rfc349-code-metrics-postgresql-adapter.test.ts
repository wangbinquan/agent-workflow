// RFC-349 — the PostgreSQL code metrics adapter must feed the exact existing
// adoption/run projection without leaking a provider handle into public APIs.

import { afterEach, describe, expect, test } from 'bun:test'

import { selectDatabaseSchemaProvider } from '@/db/providerSchema'
import { DEFAULT_METRICS_WINDOW_MS } from '@/modules/code-capability/application/codeMetricsQuery'
import { createPostgresqlCodeMetricsQuery } from '@/modules/code-capability/infrastructure/postgresqlCodeMetricsQuery'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  PostgresqlDatabaseRuntime,
  PostgresqlPool,
  PostgresqlReservedConnection,
  SqlRows,
} from '@/platform/persistence/postgresqlRuntime'

const NOW = 1_700_000_000_000

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
    generationId: 'dbg_code_metrics_pg',
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
    query: createPostgresqlCodeMetricsQuery(createPostgresqlDatabaseClient(runtime)),
    executions,
  }
}

afterEach(() => {
  selectDatabaseSchemaProvider('sqlite')
})

describe('RFC-349 PostgreSQL code metrics adapter', () => {
  test('preserves adoption disagreements and run outcomes through PostgreSQL rows', async () => {
    const fake = fixture([
      [
        ['mr-review', NOW, NOW],
        ['mr-review', null, NOW],
        ['ci-fix', NOW, null],
        ['ci-fix', null, null],
      ],
      [
        ['mr-review', 'published', NOW, 2],
        ['mr-review', 'failed', NOW, 1],
        ['ci-fix', null, NOW, 1],
        ['ci-fix', null, null, 1],
      ],
    ])

    await expect(fake.query.summary({ now: NOW })).resolves.toEqual({
      windowMs: DEFAULT_METRICS_WINDOW_MS,
      adoption: [
        {
          capability: 'ci-fix',
          published: 2,
          adopted: 0,
          quietFix: 0,
          disagreed: 1,
          outstanding: 1,
        },
        {
          capability: 'mr-review',
          published: 2,
          adopted: 1,
          quietFix: 1,
          disagreed: 0,
          outstanding: 0,
        },
      ],
      runs: [
        {
          capability: 'ci-fix',
          rounds: 2,
          published: 0,
          failed: 0,
          awaiting: 0,
          incomplete: 1,
        },
        {
          capability: 'mr-review',
          rounds: 3,
          published: 2,
          failed: 1,
          awaiting: 0,
          incomplete: 0,
        },
      ],
    })

    expect(fake.executions).toHaveLength(2)
    expect(fake.executions[0]?.sql).toContain('from "agent_workflow"."code_findings"')
    expect(fake.executions[1]?.sql).toContain('inner join "agent_workflow"."code_work_items"')
    expect(fake.executions.map((execution) => execution.parameters)).toEqual([
      [NOW - DEFAULT_METRICS_WINDOW_MS],
      [NOW - DEFAULT_METRICS_WINDOW_MS],
    ])
  })

  test('keeps an explicit window and empty result shape', async () => {
    const fake = fixture([[], []])

    await expect(fake.query.summary({ now: NOW, windowMs: 60_000 })).resolves.toEqual({
      windowMs: 60_000,
      adoption: [],
      runs: [],
    })
    expect(fake.executions.map((execution) => execution.parameters)).toEqual([
      [NOW - 60_000],
      [NOW - 60_000],
    ])
  })
})
