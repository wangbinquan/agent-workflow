import { createEpoch2PostgresqlMetadata } from './helpers/epoch2PostgresqlMetadata'
// RFC-349 — resource-limit policy consumes a provider-neutral persistence and
// Task Execution cancellation command; SQLite/PG SQL lives in infrastructure.
// RFC-395 BF-D27: the first UPDATE commits the marker; the following insertOne folds its fence.

import { withNativeTransactions } from './helpers/nativeTransactions'
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { composeResourceLimitOperations } from '@/bootstrap/resourceLimits'
import type { ResourceLimitOperations } from '@/services/limits'
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
  count = objects.length,
): SqlRows {
  return Object.assign(Promise.resolve(Object.assign([...objects], { count })), {
    async values() {
      return values
    },
  })
}

function postgresqlFixture() {
  const executions: string[] = []
  let releases = 0
  const epoch2Metadata = createEpoch2PostgresqlMetadata()
  const execute = (query: string): SqlRows => {
    executions.push(query)
    const metadata = epoch2Metadata(query)
    if (metadata) return metadata
    const compact = query.replace(/\s+/g, ' ').toLowerCase()
    // A folded INSERT mentions generations too; return its native affected-row count.
    if (compact.startsWith('insert into "agent_workflow"."recovery_events"')) {
      return rows([], [], 1)
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
  const connection: PostgresqlReservedConnection = withNativeTransactions({
    unsafe: execute,
    release() {
      releases += 1
    },
  })
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
        async callHumanWaits() {
          return [{ childTaskId: 'child', accumulatedMs: 1000, openSince: null }]
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
    await expect(
      readTaskResourceUsage(operations.persistence, 'task-policy', 20_000),
    ).resolves.toEqual({
      effectiveRunningMs: 9_000,
      totalTokens: 7,
    })
  })

  test('PostgreSQL adapter performs live provider reads/writes and uses injected cancellation', async () => {
    const fixture = postgresqlFixture()
    const cancellations: string[] = []
    const operations = composeResourceLimitOperations({
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
    const transactionStart = statements.indexOf('begin')
    expect(transactionStart).toBeGreaterThanOrEqual(0)
    expect(statements.slice(transactionStart)).toEqual([
      'begin',
      expect.stringMatching(/^select generation_id .*"generations".*for share$/),
      expect.stringContaining('select first_live_write_at'),
      expect.stringContaining('update "agent_workflow_meta"."first_write"'),
      expect.stringContaining('update "agent_workflow"."tasks"'),
      'commit',
      expect.stringContaining('insert into "agent_workflow"."recovery_events"'),
    ])
    const insert = statements.find((query) =>
      query.startsWith('insert into "agent_workflow"."recovery_events"'),
    )
    expect(insert).toMatch(/^insert into .* select /)
    expect(insert).toContain('where exists (select 1 from "agent_workflow_meta"."generations"')
    expect(insert).toContain("and state = 'active' for share)")
    expect(
      statements.filter((query) => query.includes('"agent_workflow_meta"."generations"')),
    ).toEqual([expect.stringMatching(/^select generation_id .*for share$/), insert])
    expect(fixture.releases).toBe(1)
  })

  test('service and the shared adapter prohibit direct DB facade casts and SQLite fallback', () => {
    const service = source('src/services/limits.ts')
    // RFC-359 W7：两个 provider 共用同一份实现，所以这里读的就是那一份中立文件。
    const adapter = source('src/modules/task-execution/infrastructure/taskResourceLimitFacts.ts')
    for (const forbidden of ["from '@/db/", "from 'drizzle-orm'", '.select(', '.update(']) {
      expect(service).not.toContain(forbidden)
    }
    expect(adapter).not.toContain('as DbClient')
    expect(adapter).not.toContain('createInMemoryDb')
    expect(adapter).not.toContain('openDb')
  })
})
