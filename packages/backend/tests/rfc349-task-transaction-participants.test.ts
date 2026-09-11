// RFC-349 task-core cutover — transaction-bound authorization and node-run
// minting must preserve the SQLite semantics that PostgreSQL implements with
// the same closed application inputs. In particular, observers may read a
// task but may never act on it, and minting retires superseded merge attempts
// in the same transaction that creates the replacement run.

import { afterEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq, sql } from 'drizzle-orm'

import { createInMemoryDb } from '@/db/client'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { nodeRuns, taskCollaborators, tasks, users } from '@/db/schema'
import { selectDatabaseSchemaProvider } from '@/db/providerSchema'
import { createNodeRunMintParticipantInTx } from '@/modules/task-execution/infrastructure/nodeRunMintParticipant'
import { createTaskAuthorizationParticipantInTx } from '@/modules/task-execution/infrastructure/taskAuthorization'
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
    } else if (
      normalized.includes('from "agent_workflow"."tasks"') &&
      normalized.includes('lineage_slot_path_json')
    ) {
      // RFC-359 W6 —— 铸行前会读任务的**血缘锚**（`lineage_slot_path_json` + `workflow_version`）。
      // 这一支必须排在下面那个泛化的 `from "tasks"` 之前：这个假 pool 是**按位置**返回的，
      // 泛化支给的 `[[TASK_ID]]` 会被当成第一列 `lineage_slot_path_json`，于是推导那边
      // `JSON Parse error: Unexpected identifier "rfc349"`——**假 pool 不知道查询选了哪些列**，
      // 每新增一处读新列的生产代码，它就会静默喂错值。两个 null 表示「任务尚无血缘前缀」，
      // 正是根任务的真实形状；本用例断言的是**语句落在同一条预留连接上**，不是血缘取值。
      values = [[null, null]]
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
  // RFC-359 W10：这条用例此前驱动的是 `infrastructure/sqliteTaskAuthorization.ts`——一份自
  // W1-T2c 起零生产调用方的同步孪生，本批随文件一并退役。同一判据（可见性含 viewer、
  // 动手权只认 owner/collaborator）已搬到真在跑的中立实现上，并且两个引擎各跑一遍：
  // `tests/rfc359-w10-task-authorization-conformance.test.ts`。

  // RFC-359：SQLite 这一半此前驱动同步的 `sqliteNodeRunMintParticipant.ts`（已随本波退役，
  // 生产侧只有 `services/nodeRunMint.ts#mintNodeRunTx` 一层零调用方的转发）。判据锁的是
  // **铸行与退役同笔提交**，与解释无关；改走中立参与者之后，本用例的两半（SQLite / PostgreSQL）
  // 现在是同一个形状、同一个 `nodeRunMintProgram`。
  test('replacement mint and superseded-merge retirement commit atomically', async () => {
    const db = seedTask()
    await databaseSessionFor(db).transaction(async (tx) => {
      const mint = createNodeRunMintParticipantInTx(tx)
      await mint.mint({
        id: '01RFC349000000000000000001',
        taskId: TASK_ID,
        nodeId: 'review-node',
        status: 'awaiting_review',
        cause: 'initial',
      })
      await tx
        .update(nodeRuns)
        .set({ mergeState: 'pending-merge' })
        .where(eq(nodeRuns.id, '01RFC349000000000000000001'))
        .run()
      await mint.mint({
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
      const authorization = createTaskAuthorizationParticipantInTx(tx)
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
        createNodeRunMintParticipantInTx(tx).mint({
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
