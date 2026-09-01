// RFC-349 task-core cutover — transaction-bound authorization and node-run
// minting must preserve the SQLite semantics that PostgreSQL implements with
// the same closed application inputs. In particular, observers may read a
// task but may never act on it, and minting retires superseded merge attempts
// in the same transaction that creates the replacement run.

import { afterEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq, sql } from 'drizzle-orm'

import { createInMemoryDb } from '@/db/client'
import { dbTxSync } from '@/db/txSync'
import { nodeRuns, taskCollaborators, tasks, users } from '@/db/schema'
import { selectDatabaseSchemaProvider } from '@/db/providerSchema'
import { createSqliteNodeRunMintParticipantInTx } from '@/modules/task-execution/infrastructure/sqliteNodeRunMintParticipant'
import { createPostgresqlNodeRunMintParticipantInTx } from '@/modules/task-execution/infrastructure/postgresqlNodeRunMintParticipant'
import {
  createSqliteTaskAuthorizationParticipantInTx,
  createSqliteTaskAuthorizationQueries,
} from '@/modules/task-execution/infrastructure/sqliteTaskAuthorization'
import { createPostgresqlTaskAuthorizationParticipantInTx } from '@/modules/task-execution/infrastructure/postgresqlTaskAuthorization'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  PostgresqlDatabaseRuntime,
  PostgresqlPool,
  PostgresqlReservedConnection,
  SqlRows,
} from '@/platform/persistence/postgresqlRuntime'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const TASK_ID = 'rfc349-task-auth'

afterEach(() => {
  selectDatabaseSchemaProvider('sqlite')
})

function seedTask() {
  const db = createInMemoryDb(MIGRATIONS)
  const now = 1_000
  db.insert(users)
    .values(
      ['owner', 'member', 'observer', 'outsider'].map((id) => ({
        id,
        username: id,
        displayName: id,
        createdAt: now,
        updatedAt: now,
      })),
    )
    .run()
  db.run(sql`INSERT INTO workflows (id, name, definition) VALUES ('workflow-1', 'wf', '{}')`)
  db.insert(tasks)
    .values({
      id: TASK_ID,
      name: 'task auth',
      workflowId: 'workflow-1',
      workflowSnapshot: '{}',
      repoPath: '/tmp/repo',
      worktreePath: '/tmp/worktree',
      baseBranch: 'main',
      branch: 'agent-workflow/rfc349-task-auth',
      status: 'running',
      inputs: '{}',
      startedAt: now,
      ownerUserId: 'owner',
    })
    .run()
  db.insert(taskCollaborators)
    .values([
      { taskId: TASK_ID, userId: 'owner', role: 'owner', addedBy: 'owner', addedAt: now },
      {
        taskId: TASK_ID,
        userId: 'member',
        role: 'collaborator',
        addedBy: 'owner',
        addedAt: now,
      },
      {
        taskId: TASK_ID,
        userId: 'observer',
        role: 'observer',
        addedBy: 'owner',
        addedAt: now,
      },
    ])
    .run()
  return db
}

function postgresqlFixture() {
  const statements: Array<{ readonly sql: string; readonly parameters?: readonly unknown[] }> = []
  const run = (query: string, parameters?: readonly unknown[]): SqlRows => {
    statements.push({ sql: query, parameters })
    const normalized = query.toLowerCase()
    let values: readonly (readonly unknown[])[] = []
    let objects: readonly Record<string, unknown>[] = []
    if (normalized.includes('database_generations')) {
      objects = [{ generation_id: 'rfc349-task-transaction' }]
    } else if (normalized.includes('from "agent_workflow"."tasks"')) {
      values = [[TASK_ID]]
    } else if (
      normalized.includes('from "agent_workflow"."task_collaborators"') &&
      normalized.includes('"role"')
    ) {
      values = [['observer']]
    } else if (
      normalized.includes('from "agent_workflow"."node_runs"') &&
      normalized.includes('select')
    ) {
      values = [['01RFC349000000000000000001']]
    }
    const result = [...objects] as Array<Record<string, unknown>> & { count?: number }
    result.count = objects.length
    return Object.assign(Promise.resolve(result), {
      async values() {
        return values
      },
    })
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
    generationId: 'rfc349-task-transaction',
    providerPool: () => pool,
    async health() {
      throw new Error('not used')
    },
    async readiness() {
      throw new Error('not used')
    },
    async acquireMigrationAdvisoryLock() {
      throw new Error('not used')
    },
    async close() {},
  }
  return { db: createPostgresqlDatabaseClient(runtime), statements }
}

describe('RFC-349 task transaction participants', () => {
  test('visibility includes observers while acting membership excludes them', async () => {
    const db = seedTask()
    const queries = createSqliteTaskAuthorizationQueries(db)

    for (const userId of ['owner', 'member', 'observer']) {
      await expect(
        queries.canViewTask({
          subject: { userId, canReadAllTasks: false },
          taskId: TASK_ID,
        }),
      ).resolves.toBe(true)
    }
    await expect(
      queries.canViewTask({
        subject: { userId: 'outsider', canReadAllTasks: false },
        taskId: TASK_ID,
      }),
    ).resolves.toBe(false)
    await expect(
      queries.canViewTask({
        subject: { userId: 'outsider', canReadAllTasks: true },
        taskId: 'missing-task',
      }),
    ).resolves.toBe(false)

    expect(
      dbTxSync(db, (tx) => {
        const authorization = createSqliteTaskAuthorizationParticipantInTx(tx)
        return {
          owner: authorization.canActOnTask({ userId: 'owner', taskId: TASK_ID }),
          member: authorization.canActOnTask({ userId: 'member', taskId: TASK_ID }),
          observer: authorization.canActOnTask({ userId: 'observer', taskId: TASK_ID }),
          outsider: authorization.canActOnTask({ userId: 'outsider', taskId: TASK_ID }),
        }
      }),
    ).toEqual({ owner: true, member: true, observer: false, outsider: false })
  })

  test('replacement mint and superseded-merge retirement commit atomically', () => {
    const db = seedTask()
    dbTxSync(db, (tx) => {
      const mint = createSqliteNodeRunMintParticipantInTx(tx)
      mint.mint({
        id: '01RFC349000000000000000001',
        taskId: TASK_ID,
        nodeId: 'review-node',
        status: 'awaiting_review',
        cause: 'initial',
      })
      tx.update(nodeRuns)
        .set({ mergeState: 'pending-merge' })
        .where(eq(nodeRuns.id, '01RFC349000000000000000001'))
        .run()
      mint.mint({
        id: '01RFC349000000000000000002',
        taskId: TASK_ID,
        nodeId: 'review-node',
        status: 'awaiting_review',
        cause: 'review-iterate',
      })
    })

    expect(
      db
        .select({ id: nodeRuns.id, mergeState: nodeRuns.mergeState })
        .from(nodeRuns)
        .where(eq(nodeRuns.taskId, TASK_ID))
        .all(),
    ).toEqual([
      { id: '01RFC349000000000000000001', mergeState: 'abandoned' },
      { id: '01RFC349000000000000000002', mergeState: null },
    ])
  })

  test('PostgreSQL binds authorization and minting to one reserved transaction', async () => {
    const fixture = postgresqlFixture()
    await fixture.db.transaction(async (tx) => {
      const authorization = createPostgresqlTaskAuthorizationParticipantInTx(tx)
      await expect(
        authorization.canViewTask({
          subject: { userId: 'observer', canReadAllTasks: false },
          taskId: TASK_ID,
        }),
      ).resolves.toBe(true)
      await expect(
        authorization.canActOnTask({ userId: 'observer', taskId: TASK_ID }),
      ).resolves.toBe(false)

      await expect(
        createPostgresqlNodeRunMintParticipantInTx(tx).mint({
          id: '01RFC349000000000000000002',
          taskId: TASK_ID,
          nodeId: 'review-node',
          status: 'awaiting_review',
          cause: 'review-iterate',
        }),
      ).resolves.toBe('01RFC349000000000000000002')
    })

    const sqlText = fixture.statements.map((statement) => statement.sql.toLowerCase()).join('\n')
    expect(sqlText).toContain('update "agent_workflow"."node_runs"')
    expect(sqlText).toContain('insert into "agent_workflow"."node_runs"')
    expect(
      fixture.statements.filter((statement) => /^begin\b/i.test(statement.sql.trim())),
    ).toHaveLength(1)
    expect(
      fixture.statements.filter((statement) => /^commit\b/i.test(statement.sql.trim())),
    ).toHaveLength(1)
  })
})
