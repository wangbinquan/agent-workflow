// RFC-349 — native runtime-session ownership is a provider-selected Promise
// atom. SQLite locks the complete reset/resume behavior; the PostgreSQL oracle
// proves the same claim is compiled against the real PostgreSQL projection.

import { afterEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { resolve } from 'node:path'

import { createInMemoryDb } from '@/db/client'
import { nodeRunEvents, nodeRuns, tasks, workflows } from '@/db/schema'
import { selectDatabaseSchemaProvider } from '@/db/providerSchema'
import { createPostgresqlRuntimeSessionLeaseOperations } from '@/modules/task-execution/infrastructure/postgresqlRuntimeSessionLeaseOperations'
import { createSqliteRuntimeSessionLeaseOperations } from '@/modules/task-execution/infrastructure/sqliteRuntimeSessionLeaseOperations'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  PostgresqlDatabaseRuntime,
  PostgresqlPool,
  PostgresqlReservedConnection,
  SqlRows,
} from '@/platform/persistence/postgresqlRuntime'
import {
  claimNewRuntimeSession,
  confirmRuntimeSessionResume,
  getRuntimeSessionLease,
  markRuntimeSessionResetPending,
  preclaimRuntimeSessionResume,
  releaseRuntimeSessionLease,
  repairRuntimeSessionLeasesAfterOrphanReap,
  rotateRuntimeSessionLease,
} from '@/services/runtimeSessionLease'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function seedTaskRuns() {
  const db = createInMemoryDb(MIGRATIONS)
  db.insert(workflows)
    .values({ id: 'workflow-lease', name: 'workflow-lease', definition: '{}' })
    .run()
  db.insert(tasks)
    .values({
      id: 'task-lease',
      name: 'task-lease',
      workflowId: 'workflow-lease',
      workflowSnapshot: '{}',
      repoPath: '/tmp/repo',
      worktreePath: '/tmp/worktree',
      baseBranch: 'main',
      branch: 'aw/lease',
      status: 'running',
      inputs: '{}',
      startedAt: 1,
    })
    .run()
  db.insert(nodeRuns)
    .values(
      ['run-1', 'run-2', 'run-3'].map((id) => ({
        id,
        taskId: 'task-lease',
        nodeId: 'node-a',
        status: 'running' as const,
      })),
    )
    .run()
  return db
}

function rows(
  values: readonly (readonly unknown[])[] = [],
  objects: readonly Record<string, unknown>[] = [],
): SqlRows {
  return Object.assign(Promise.resolve(objects), {
    async values() {
      return values
    },
  })
}

function postgresqlFixture() {
  const executions: Array<{ readonly sql: string; readonly parameters?: readonly unknown[] }> = []
  const run = (query: string, parameters?: readonly unknown[]) => {
    executions.push({ sql: query, parameters })
    const normalized = query.toLowerCase()
    if (normalized.includes('database_generations')) {
      return rows(
        [['dbg_runtime_session_lease_pg']],
        [{ generation_id: 'dbg_runtime_session_lease_pg' }],
      )
    }
    if (normalized.includes('from "agent_workflow"."node_runs"')) return rows([['run-1']])
    return rows()
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
    generationId: 'dbg_runtime_session_lease_pg',
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
    operations: createPostgresqlRuntimeSessionLeaseOperations(
      createPostgresqlDatabaseClient(runtime),
    ),
    executions,
  }
}

afterEach(() => {
  selectDatabaseSchemaProvider('sqlite')
})

describe('RFC-349 runtime-session lease provider operations', () => {
  test('SQLite preserves claim, reset rotation, resume, and terminal repair semantics', async () => {
    const db = seedTaskRuns()
    const operations = createSqliteRuntimeSessionLeaseOperations(db)
    const first = await claimNewRuntimeSession(operations, {
      protocol: 'claude-code',
      sessionId: 'native-before-reset',
      taskId: 'task-lease',
      nodeId: 'node-a',
      currentNodeRunId: 'run-1',
      leaseNonceDigest: 'nonce-1',
      leasedAt: 10,
    })
    db.insert(nodeRunEvents)
      .values({
        nodeRunId: 'run-1',
        ts: 1,
        kind: 'text',
        payload: '{}',
        sessionId: first.sessionId,
      })
      .run()

    await expect(
      claimNewRuntimeSession(operations, {
        protocol: 'claude-code',
        sessionId: first.sessionId,
        taskId: 'task-lease',
        nodeId: 'node-a',
        currentNodeRunId: 'run-2',
        leaseNonceDigest: 'nonce-conflict',
      }),
    ).rejects.toMatchObject({ code: 'runtime-session-conflict', reason: 'owner-conflict' })
    await expect(
      rotateRuntimeSessionLease(operations, first, 'native-after-reset'),
    ).rejects.toMatchObject({
      reason: 'lease-mismatch',
    })

    await expect(markRuntimeSessionResetPending(operations, first)).resolves.toBe(true)
    const rotated = await rotateRuntimeSessionLease(operations, first, 'native-after-reset')
    await expect(
      getRuntimeSessionLease(operations, 'claude-code', first.sessionId),
    ).resolves.toBeUndefined()
    await expect(
      getRuntimeSessionLease(operations, 'claude-code', rotated.sessionId),
    ).resolves.toMatchObject({ createdNodeRunId: 'run-1', leaseNodeRunId: 'run-1' })
    expect(db.select({ sessionId: nodeRunEvents.sessionId }).from(nodeRunEvents).get()).toEqual({
      sessionId: rotated.sessionId,
    })
    await expect(releaseRuntimeSessionLease(operations, rotated)).resolves.toBe(true)

    const resumed = await preclaimRuntimeSessionResume(operations, {
      protocol: 'claude-code',
      sessionId: rotated.sessionId,
      taskId: 'task-lease',
      nodeId: 'node-a',
      currentNodeRunId: 'run-2',
      leaseNonceDigest: 'nonce-2',
      leasedAt: 20,
    })
    await expect(confirmRuntimeSessionResume(operations, resumed)).resolves.toBe(true)
    db.update(nodeRuns).set({ status: 'failed' }).where(eq(nodeRuns.id, 'run-2')).run()
    await expect(repairRuntimeSessionLeasesAfterOrphanReap(operations, true)).resolves.toBe(1)
    await expect(releaseRuntimeSessionLease(operations, resumed)).resolves.toBe(false)
  })

  test('facade rejects malformed claims before reaching provider infrastructure', async () => {
    const operations = createSqliteRuntimeSessionLeaseOperations(seedTaskRuns())
    await expect(
      claimNewRuntimeSession(operations, {
        protocol: 'opencode',
        sessionId: '',
        taskId: 'task-lease',
        nodeId: 'node-a',
        currentNodeRunId: 'run-1',
        leaseNonceDigest: 'nonce',
      }),
    ).rejects.toMatchObject({ code: 'runtime-session-conflict', reason: 'invalid-input' })
  })

  test('PostgreSQL claim uses the selected schema and generation-fenced transaction', async () => {
    const fake = postgresqlFixture()
    await expect(
      claimNewRuntimeSession(fake.operations, {
        protocol: 'opencode',
        sessionId: 'native-pg',
        taskId: 'task-pg',
        nodeId: 'node-pg',
        currentNodeRunId: 'run-1',
        leaseNonceDigest: 'nonce-pg',
        leasedAt: 30,
      }),
    ).resolves.toEqual({
      protocol: 'opencode',
      sessionId: 'native-pg',
      nodeRunId: 'run-1',
      leaseNonceDigest: 'nonce-pg',
    })

    const statements = fake.executions.map((execution) => execution.sql.toLowerCase())
    expect(statements).toContain('set transaction isolation level serializable')
    expect(statements.some((sql) => sql.includes('task_execution_owners'))).toBe(true)
    expect(
      statements.some((sql) =>
        sql.includes('insert into "agent_workflow"."runtime_session_leases"'),
      ),
    ).toBe(true)
    expect(statements.some((sql) => sql.includes('database_generations'))).toBe(true)
  })
})
