// RFC-349 — resource-limit policy consumes a provider-neutral persistence and
// Task Execution cancellation command; SQLite/PG SQL lives in infrastructure.

import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { selectDatabaseSchemaProvider } from '@/db/providerSchema'
import { composePostgresqlResourceLimitOperations } from '@/modules/system-operations/composition/resourceLimits'
import type { ResourceLimitOperations } from '@/modules/system-operations/public/operations'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  PostgresqlDatabaseRuntime,
  PostgresqlPool,
  PostgresqlReservedConnection,
  SqlRows,
} from '@/platform/persistence/postgresqlRuntime'
import { enforceLimits, readTaskResourceUsage } from '@/services/limits'

function source(relativePath: string): string {
  return readFileSync(resolve(import.meta.dir, '..', relativePath), 'utf8')
}

function rows(
  values: readonly (readonly unknown[])[] = [],
  objects: readonly Record<string, unknown>[] = [],
): SqlRows {
  return Object.assign(Promise.resolve([...objects]), {
    async values() {
      return values
    },
  })
}

function postgresqlFixture() {
  const executions: string[] = []
  let releases = 0
  const execute = (query: string): SqlRows => {
    executions.push(query)
    const compact = query.replace(/\s+/g, ' ').toLowerCase()
    if (compact.includes('database_generations')) {
      return rows([], [{ generation_id: 'dbg_limits_pg' }])
    }
    if (
      compact.startsWith('select') &&
      compact.includes('from "agent_workflow"."tasks"') &&
      compact.includes('max_duration_ms')
    ) {
      return rows([['task-pg', null, 5, 0, null]])
    }
    if (
      compact.startsWith('select') &&
      compact.includes('from "agent_workflow"."node_runs"') &&
      compact.includes('child_task_id')
    ) {
      return rows()
    }
    if (compact.startsWith('select') && compact.includes('sum(')) return rows([['7']])
    return rows()
  }
  const connection: PostgresqlReservedConnection = {
    unsafe: execute,
    release() {
      releases += 1
    },
  }
  const pool: PostgresqlPool = {
    async reserve() {
      return connection
    },
    unsafe: execute,
    async close() {},
  }
  const runtime: PostgresqlDatabaseRuntime = {
    provider: 'postgresql',
    generationId: 'dbg_limits_pg',
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
    db: createPostgresqlDatabaseClient(runtime),
    executions,
    get releases() {
      return releases
    },
  }
}

afterEach(() => {
  selectDatabaseSchemaProvider('sqlite')
})

describe('RFC-349 resource-limit provider seam', () => {
  test('policy uses only the required async operations and preserves human-wait usage', async () => {
    const cancellations: string[] = []
    const audits: string[] = []
    const operations: ResourceLimitOperations = {
      cancelTask: async (taskId) => {
        cancellations.push(taskId)
      },
      persistence: {
        async listRunningTasks() {
          return [
            {
              id: 'task-policy',
              maxDurationMs: 5_000,
              maxTotalTokens: null,
              runningMs: 10_000,
              runningSince: null,
            },
          ]
        },
        async listCallRows() {
          return [{ childTaskId: 'child', wrapperProgressJson: '{"callHumanWaitMs":1000}' }]
        },
        async listTaskStatuses() {
          return ['done']
        },
        async sumTaskTokens() {
          return 7
        },
        async readTaskClock() {
          return { runningMs: 10_000, runningSince: null }
        },
        async writeLimitReason() {},
        async recordLimitCancellation(input) {
          audits.push(input.reason)
        },
      },
    }

    await expect(enforceLimits(operations, 20_000)).resolves.toEqual({
      scanned: 1,
      canceled: ['task-policy'],
    })
    expect(cancellations).toEqual(['task-policy'])
    expect(audits).toEqual(['task-time-limit-exceeded'])
    await expect(readTaskResourceUsage(operations, 'task-policy', 20_000)).resolves.toEqual({
      effectiveRunningMs: 9_000,
      totalTokens: 7,
    })
  })

  test('PostgreSQL adapter performs live provider reads/writes and uses injected cancellation', async () => {
    const fixture = postgresqlFixture()
    const cancellations: string[] = []
    const operations = composePostgresqlResourceLimitOperations({
      db: fixture.db,
      cancelTask: async (taskId) => {
        cancellations.push(taskId)
      },
    })

    await expect(enforceLimits(operations, 20_000)).resolves.toEqual({
      scanned: 1,
      canceled: ['task-pg'],
    })
    expect(cancellations).toEqual(['task-pg'])
    const statements = fixture.executions.map((query) => query.toLowerCase())
    expect(statements.some((query) => query.includes('update "agent_workflow"."tasks"'))).toBe(true)
    expect(
      statements.some((query) => query.includes('insert into "agent_workflow"."recovery_events"')),
    ).toBe(true)
    expect(statements.filter((query) => query.includes('database_generations'))).toHaveLength(2)
    expect(fixture.releases).toBe(2)
  })

  test('service and PostgreSQL adapter prohibit direct DB facade casts and SQLite fallback', () => {
    const service = source('src/services/limits.ts')
    const adapter = source(
      'src/modules/system-operations/infrastructure/postgresqlResourceLimitPersistence.ts',
    )
    for (const forbidden of ["from '@/db/", "from 'drizzle-orm'", '.select(', '.update(']) {
      expect(service).not.toContain(forbidden)
    }
    expect(adapter).not.toContain('as DbClient')
    expect(adapter).not.toContain('createInMemoryDb')
    expect(adapter).not.toContain('openDb')
  })
})
