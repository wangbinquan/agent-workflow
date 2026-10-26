import { taskAggregateWrite } from '@/modules/task-execution/infrastructure/taskDefinitionWriteParticipant'
import { withTargetMintIdentity } from './helpers/rfc395Mint'
// RFC-349 task-core cutover — transaction-bound authorization and node-run
// minting must preserve the SQLite semantics that PostgreSQL implements with
// the same closed application inputs. In particular, observers may read a
// task but may never act on it, and minting retires superseded merge attempts
// in the same transaction that creates the replacement run.
//
// RFC-369: minting no longer retires anything — that same-frame range read made
// concurrent mints of one task abort each other under PostgreSQL SERIALIZABLE.
// Supersession is derived on read; the mint's transaction holds only the insert.

import {
  patchNodeRunFixture,
  readNodeRunFixtures,
  taskFixture,
  workflowFixture,
} from './helpers/model'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { expect, test } from 'bun:test'

import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { describeEachProvider } from './helpers/eachProvider'
import { derivedSupersededIds } from './helpers/nodeRunSupersession'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { createNodeRunMintParticipantInTx } from '@/modules/task-execution/infrastructure/nodeRunMintParticipant'
import { createTaskAuthorizationParticipantInTx } from '@/modules/task-execution/infrastructure/taskAuthorization'

const TASK_ID = 'rfc349-task-auth'

async function seedTask(db: PersistenceDb) {
  const now = 1_000
  const { users, taskCollaborators } = tablesOf(db)
  await db.insert(users).values(
    ['owner', 'member', 'observer', 'outsider'].map((id) => ({
      id,
      username: id,
      displayName: id,
      createdAt: now,
      updatedAt: now,
    })),
  )

  await workflowFixture(db, { id: 'workflow-1', name: 'wf', definition: '{}' })
  await taskFixture(db, {
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

  await db.insert(taskCollaborators).values([
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

  return db
}

describeEachProvider('RFC-349 task transaction participants', (harness) => {
  // RFC-359 W10：这条用例此前驱动的是 `infrastructure/sqliteTaskAuthorization.ts`——一份自
  // W1-T2c 起零生产调用方的同步孪生，本批随文件一并退役。同一判据（可见性含 viewer、
  // 动手权只认 owner/collaborator）已搬到真在跑的中立实现上，并且两个引擎各跑一遍：
  // `tests/rfc359-w10-task-authorization-conformance.test.ts`。

  // RFC-359：SQLite 这一半此前驱动同步的 `sqliteNodeRunMintParticipant.ts`（已随本波退役，
  // 生产侧只有 `services/nodeRunMint.ts#mintNodeRunTx` 一层零调用方的转发）。判据锁的是
  // **铸行与退役同笔提交**，与解释无关；改走中立参与者之后，本用例的两半（SQLite / PostgreSQL）
  // 现在是同一个形状、同一个 `nodeRunMintProgram`。
  test('replacement mint commits alone; the superseded prior attempt is derived, not written (RFC-369)', async () => {
    const db = await seedTask(harness.db)
    await databaseSessionFor(db).transaction(async (tx) => {
      await taskAggregateWrite.lockTaskAggregateRoot(tx, TASK_ID)

      const mint = createNodeRunMintParticipantInTx(tx)
      await mint.mint(
        withTargetMintIdentity({
          role: 'node-attempt',
          syntheticKind: null,
          id: '01RFC349000000000000000001',
          taskId: TASK_ID,
          nodeId: 'review-node',
          status: 'awaiting_review',
          cause: 'initial',
        }),
      )
      await patchNodeRunFixture(
        tx,
        { id: '01RFC349000000000000000001' },
        { mergeState: 'pending-merge' },
      )

      await mint.mint(
        withTargetMintIdentity({
          role: 'node-attempt',
          syntheticKind: null,
          id: '01RFC349000000000000000002',
          taskId: TASK_ID,
          nodeId: 'review-node',
          status: 'awaiting_review',
          cause: 'review-iterate',
        }),
      )
    })

    expect(
      await readNodeRunFixtures(db, { taskId: TASK_ID }).then((rows) =>
        rows.map((row) => ({ id: row.id, mergeState: row.mergeState })),
      ),
    ).toEqual([
      { id: '01RFC349000000000000000001', mergeState: 'pending-merge' },
      { id: '01RFC349000000000000000002', mergeState: null },
    ])
    expect(await derivedSupersededIds(db, TASK_ID)).toEqual(['01RFC349000000000000000001'])
  })

  test('authorization and target mint companions share one real owner transaction', async () => {
    const db = await seedTask(harness.db)
    const recording = harness.recordStatements()
    try {
      await databaseSessionFor(db).transaction(async (tx) => {
        await taskAggregateWrite.lockTaskAggregateRoot(tx, TASK_ID)
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
          createNodeRunMintParticipantInTx(tx).mint(
            withTargetMintIdentity({
              role: 'node-attempt',
              syntheticKind: null,
              id: '01RFC349000000000000000002',
              taskId: TASK_ID,
              nodeId: 'review-node',
              status: 'awaiting_review',
              cause: 'review-iterate',
              overrides: {
                config: { agentOverrideName: 'fixture' },
                inputs: { consumedUpstreamRunsJson: '{}' },
              },
            }),
          ),
        ).resolves.toBe('01RFC349000000000000000002')
      })
    } finally {
      recording.stop()
    }
    const inserts = recording.statements.filter(({ sql }) => /insert into/i.test(sql))
    expect(
      inserts.map(({ sql }) => sql.match(/insert into (?:"[^"]+"\.)?"([^"]+)"/i)?.[1]),
    ).toEqual(['node_run_seq_allocations', 'node_runs', 'node_run_configs', 'node_run_selections'])
    expect(recording.statements.filter(({ sql }) => /^begin\b/i.test(sql.trim()))).toHaveLength(1)
    expect(recording.statements.filter(({ sql }) => /^commit\b/i.test(sql.trim()))).toHaveLength(1)
    const [run] = await readNodeRunFixtures(db, { id: '01RFC349000000000000000002' })
    expect(run?.agentOverrideName).toBe('fixture')
  })
})
