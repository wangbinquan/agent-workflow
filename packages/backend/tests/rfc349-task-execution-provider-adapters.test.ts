// RFC-349 T5/C2 — the task-execution provider adapters share one Promise
// ownership contract.  This oracle locks the SQLite behavior and proves the
// PostgreSQL implementation fences the same exact owner tuple and lease epoch.

import { afterEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

import { createInMemoryDb } from '@/db/client'
import { taskRepos, tasks } from '@/db/schema'
import { selectDatabaseSchemaProvider } from '@/db/providerSchema'
import { createSqliteTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import {
  createOwnershipToken,
  createWorkerIdentity,
} from '@/modules/task-execution/domain/ownership'
import { PostgresqlTaskOwnershipPersistence } from '@/modules/task-execution/infrastructure/postgresqlTaskOwnershipPersistence'
import {
  assertPostgresqlTaskOwnerTx,
  withPostgresqlSerializableTaskExecution,
} from '@/modules/task-execution/infrastructure/postgresqlTaskLifecycleTransaction'
import { canonicalJson } from '@/modules/task-execution/domain/executionIntent'
import { PostgresqlTaskEngineApplicationPersistence } from '@/modules/task-execution/infrastructure/postgresqlTaskEngineApplicationPersistence'
import {
  createPostgresqlTaskExecutionResourceBinding,
  type PostgresqlTaskExecutionResourceSnapshotInTransaction,
} from '@/modules/task-execution/infrastructure/postgresqlTaskExecutionResourceSnapshots'
import { createSqliteTaskExecutionResourceBinding } from '@/modules/task-execution/infrastructure/sqliteTaskExecutionResourceSnapshots'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { Actor } from '@/auth/actor'
import type {
  ResourceRequestContext,
  TaskExecutionResourceSnapshotInTx,
} from '@/modules/resource-catalog/public/participants'
import type {
  FrozenTaskExecutionResourceSnapshot,
  TaskExecutionResourceRequest,
} from '@/modules/resource-catalog/public/types'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import type {
  PostgresqlDatabaseRuntime,
  PostgresqlPool,
  PostgresqlReservedConnection,
  SqlRows,
} from '@/platform/persistence/postgresqlRuntime'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Response {
  readonly objects?: readonly Record<string, unknown>[]
  readonly values?: readonly (readonly unknown[])[]
  readonly count?: number
}

function rows(response: Response): SqlRows {
  const objects = [...(response.objects ?? [])] as Array<Record<string, unknown>> & {
    count?: number
  }
  objects.count = response.count ?? objects.length
  return Object.assign(Promise.resolve(objects), {
    async values() {
      return response.values ?? []
    },
  })
}

function postgresqlFixture(responses: Response[]) {
  const executions: Array<{ readonly sql: string; readonly parameters?: readonly unknown[] }> = []
  const run = (query: string, parameters?: readonly unknown[]) => {
    executions.push({ sql: query, parameters })
    // RFC-349: the one-shot live-write marker and the per-transaction
    // generation fence are infrastructure, not part of the adapter contract
    // each case queues responses for. Answer them without consuming the queue.
    if (query.includes('database_generations'))
      return rows({ objects: [{ generation_id: 'dbg_task_execution_pg' }] })
    return rows(responses.shift() ?? {})
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
    generationId: 'dbg_task_execution_pg',
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
  return { db: createPostgresqlDatabaseClient(runtime), executions }
}

afterEach(() => {
  selectDatabaseSchemaProvider('sqlite')
})

describe('RFC-349 task-execution provider adapters', () => {
  test('SQLite aggregate admits, claims, and heartbeats through Promise ports', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    db.insert(tasks)
      .values({
        id: 'task-1',
        name: 'task-1',
        workflowId: 'workflow-1',
        workflowSnapshot: '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}',
        workflowVersion: 1,
        repoPath: '/tmp/repo',
        worktreePath: '/tmp/worktree',
        baseBranch: 'main',
        branch: 'agent-workflow/task-1',
        status: 'pending',
        inputs: '{}',
        startedAt: 1,
        executionLineageId: 'task-1',
        lineageSlotPathJson: canonicalJson([
          {
            stableNodeKey: 'task-root',
            frozenOccurrenceKey: 'task-1',
            workflowRevision: 1,
          },
        ]),
      })
      .run()
    db.insert(taskRepos)
      .values({
        taskId: 'task-1',
        repoIndex: 0,
        repoPath: '/tmp/repo',
        baseBranch: 'main',
        branch: 'agent-workflow/task-1',
        worktreePath: '/tmp/worktree',
      })
      .run()
    const persistence = createSqliteTaskExecutionPersistence(db)
    await expect(persistence.drive.load('task-1')).resolves.toMatchObject({
      task: { id: 'task-1', status: 'pending' },
      repositories: [{ repoIndex: 0, workspaceProfileVersion: null }],
    })
    await expect(
      persistence.drive.updateWorkspaceProfile({
        taskId: 'task-1',
        repoIndex: 0,
        version: 1,
        digest: 'profile-v1',
        now: 9,
      }),
    ).resolves.toBe(true)
    const submitted = await persistence.intents.submitContinuation({
      taskId: 'task-1',
      intentId: 'intent-1',
      kind: 'launch',
      source: 'rest',
      actorUserId: 'user-1',
      payload: { v: 1 },
      now: 10,
      advanceOperationGeneration: false,
    })
    expect(submitted).toMatchObject({ intentId: 'intent-1', state: 'pending' })

    const token = await persistence.ownership.claimPendingIntent({
      intentId: submitted.intentId,
      identity: createWorkerIdentity({ ownerId: 'worker-1', daemonGeneration: 'daemon-1' }),
      now: 11,
      leaseMs: 100,
    })
    const heartbeat = await persistence.ownership.heartbeat({ token, now: 12, leaseMs: 100 })
    expect(heartbeat).toMatchObject({
      taskId: 'task-1',
      ownerId: 'worker-1',
      daemonGeneration: 'daemon-1',
      epoch: 1,
      leaseUntil: 112,
      ownerRevision: 2,
    })
    await expect(persistence.ownership.read('task-1')).resolves.toMatchObject({
      state: 'claimed',
      revision: 2,
    })
  })

  test('PostgreSQL heartbeat fences the exact owner tuple and returns the renewed lease', async () => {
    const identity = createWorkerIdentity({ ownerId: 'worker-1', daemonGeneration: 'daemon-1' })
    const token = createOwnershipToken({
      taskId: 'task-1',
      identity,
      epoch: 7,
      leaseUntil: 100,
      ownerRevision: 3,
    })
    const fake = postgresqlFixture([{}, { values: [[4, 250]] }, {}])
    const persistence = new PostgresqlTaskOwnershipPersistence(fake.db)

    await expect(persistence.heartbeat({ token, now: 150, leaseMs: 100 })).resolves.toMatchObject({
      taskId: 'task-1',
      ownerId: 'worker-1',
      daemonGeneration: 'daemon-1',
      epoch: 7,
      leaseUntil: 250,
      ownerRevision: 4,
    })

    const update = fake.executions.find((execution) =>
      execution.sql.toLowerCase().includes('update "agent_workflow"."task_execution_owners"'),
    )
    expect(update?.sql).toContain('"task_id"')
    expect(update?.sql).toContain('"owner_id"')
    expect(update?.sql).toContain('"daemon_generation"')
    expect(update?.sql).toContain('"epoch"')
    expect(update?.sql).toContain('"state"')
    expect(update?.sql.toLowerCase()).toContain('returning')
  })

  test('PostgreSQL stale heartbeat fails with the provider-neutral fence code', async () => {
    const identity = createWorkerIdentity({ ownerId: 'worker-1', daemonGeneration: 'daemon-1' })
    const token = createOwnershipToken({
      taskId: 'task-1',
      identity,
      epoch: 7,
      leaseUntil: 100,
      ownerRevision: 3,
    })
    const fake = postgresqlFixture([{}, { values: [] }, {}])

    await expect(
      new PostgresqlTaskOwnershipPersistence(fake.db).heartbeat({
        token,
        now: 150,
        leaseMs: 100,
      }),
    ).rejects.toMatchObject({ code: 'task-execution-stale-owner' })
  })

  test('PostgreSQL owned mutation advances revision without fencing a live heartbeat snapshot', async () => {
    const identity = createWorkerIdentity({ ownerId: 'worker-1', daemonGeneration: 'daemon-1' })
    const token = createOwnershipToken({
      taskId: 'task-1',
      identity,
      epoch: 7,
      leaseUntil: 100,
      ownerRevision: 3,
    })
    const fake = postgresqlFixture([{}, {}, { values: [[9]] }, {}])

    await expect(
      withPostgresqlSerializableTaskExecution(fake.db, async (tx) => {
        await assertPostgresqlTaskOwnerTx(tx, token, 200)
      }),
    ).resolves.toBeUndefined()

    const update = fake.executions.find((execution) =>
      execution.sql.toLowerCase().includes('update "agent_workflow"."task_execution_owners"'),
    )
    expect(update?.sql).toContain('"revision" + 1')
    expect(update?.sql).toContain('"owner_id"')
    expect(update?.sql).toContain('"daemon_generation"')
    expect(update?.sql).toContain('"epoch"')
    expect(update?.sql).not.toContain('"lease_until" =')
  })

  test('PostgreSQL workspace profile write shares the exact owner fence transaction', async () => {
    const token = createOwnershipToken({
      taskId: 'task-1',
      identity: createWorkerIdentity({ ownerId: 'worker-1', daemonGeneration: 'daemon-1' }),
      epoch: 7,
      leaseUntil: 100,
      ownerRevision: 3,
    })
    const fake = postgresqlFixture([{}, {}, { values: [[9]] }, { values: [[0]] }, {}])

    await expect(
      new PostgresqlTaskEngineApplicationPersistence(fake.db).updateWorkspaceProfile({
        taskId: 'task-1',
        repoIndex: 0,
        version: 1,
        digest: 'profile-v1',
        executionContext: { intentId: 'intent-1', token },
        now: 200,
      }),
    ).resolves.toBe(true)

    const statements = fake.executions.map((execution) => execution.sql.toLowerCase())
    expect(statements.findIndex((sql) => sql.includes('task_execution_owners'))).toBeLessThan(
      statements.findIndex((sql) => sql.includes('update "agent_workflow"."task_repos"')),
    )
  })

  test('SQLite and PostgreSQL freeze the same call closure behind one async atomic port', async () => {
    const emptyDefinition = {
      $schema_version: 4,
      inputs: [],
      nodes: [],
      edges: [],
    } as WorkflowDefinition
    const rootDefinition = {
      ...emptyDefinition,
      nodes: [{ id: 'call-child', kind: 'call-workflow', workflowName: 'child' } as WorkflowNode],
    } as WorkflowDefinition
    const pair = {
      authority: {} as ResourceRequestContext,
      actor: {} as Actor,
    }
    const load = (
      _authority: ResourceRequestContext,
      requests: readonly TaskExecutionResourceRequest[],
    ): readonly FrozenTaskExecutionResourceSnapshot[] =>
      requests.map((request) => {
        if (request.kind !== 'call-workflow') {
          throw new Error(`unexpected resource request '${request.kind}'`)
        }
        return {
          kind: 'call-workflow' as const,
          sourceWorkflowId: request.sourceWorkflowId,
          nodeId: request.nodeId,
          workflow: {
            id: 'workflow-child',
            name: 'child',
            version: 3,
            definition: emptyDefinition,
          },
        }
      })

    const sqlite = createInMemoryDb(MIGRATIONS)
    const sqliteBinding = createSqliteTaskExecutionResourceBinding(sqlite, {
      inTransaction() {
        return { loadAuthorized: load } as unknown as TaskExecutionResourceSnapshotInTx
      },
    })
    const sqliteClosure = await sqliteBinding.freezeCallClosure(pair, {
      id: 'workflow-root',
      definition: rootDefinition,
    })

    const fake = postgresqlFixture([])
    const postgresqlBinding = createPostgresqlTaskExecutionResourceBinding(fake.db, {
      inTransaction() {
        return {
          async loadAuthorized(authority, requests) {
            return load(authority, requests)
          },
        } satisfies PostgresqlTaskExecutionResourceSnapshotInTransaction
      },
    })
    const postgresqlClosure = await postgresqlBinding.freezeCallClosure(pair, {
      id: 'workflow-root',
      definition: rootDefinition,
    })

    expect(postgresqlClosure).toBe(sqliteClosure)
    expect(JSON.parse(postgresqlClosure ?? '{}')).toMatchObject({
      closureVersion: 2,
      workflows: {
        'workflow-root#call-child': { id: 'workflow-child', version: 3 },
      },
      workgroups: {},
    })
    expect(
      fake.executions.filter((execution) =>
        execution.sql.includes('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'),
      ),
    ).toHaveLength(1)
  })
})
