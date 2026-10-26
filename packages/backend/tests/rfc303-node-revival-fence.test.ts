// RFC-303: every node-run writer must honor the task-owned terminal fence.
// Lock all three lifecycle APIs so review/human repair and retry paths cannot
// revive external work after an MR / PR terminal fact committed.
import { nodeRunFixture, patchTaskFixture, taskFixture, workflowFixture } from './helpers/model'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'

import { describeEachProvider } from './helpers/eachProvider'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { fenceTaskWrite } from '@/modules/task-execution/infrastructure/ownedTaskExecution'
import { lockNodeRunTaskRootInTx } from '@/modules/task-execution/infrastructure/nodeRunWriteProtocol'
import { setNodeRunStatus, setNodeRunStatusTx, transitionNodeRunStatus } from '@/services/lifecycle'

async function fixture(db: PersistenceDb, status: 'pending' | 'done') {
  await workflowFixture(db, { id: 'workflow-1', name: 'workflow', definition: '{}' })
  await taskFixture(db, {
    id: 'task-1',
    name: 'task',
    workflowId: 'workflow-1',
    workflowSnapshot: '{}',
    repoPath: '/tmp/repo',
    worktreePath: '/tmp/worktree',
    baseBranch: 'main',
    branch: 'agent-workflow/task-1',
    status: 'canceled',
    inputs: '{}',
    startedAt: 1,
    sourceTerminationFence: 'closed',
  })
  await nodeRunFixture(db, {
    id: 'run-1',
    taskId: 'task-1',
    nodeId: 'node-1',
    status,
  })
  return db
}

async function expectClosed(operation: () => Promise<unknown> | unknown): Promise<void> {
  try {
    await operation()
    throw new Error('expected source termination fence')
  } catch (error) {
    expect(error).toMatchObject({ code: 'task-source-terminal-closed' })
  }
}

describeEachProvider('RFC-303 node-run terminal fence', (harness) => {
  test('named transition cannot dispatch a pending node', async () => {
    const db = await fixture(harness.db, 'pending')
    await expectClosed(() =>
      transitionNodeRunStatus({ db, nodeRunId: 'run-1', event: { kind: 'mark-running' } }),
    )
    const { nodeRuns } = tablesOf(db)
    expect((await db.select().from(nodeRuns).where(eq(nodeRuns.id, 'run-1')))[0]?.status).toBe(
      'pending',
    )
  })

  test('async and transactional lower-level revival paths fail with the stable code', async () => {
    const db = await fixture(harness.db, 'done')
    await expectClosed(() =>
      setNodeRunStatus({
        db,
        nodeRunId: 'run-1',
        to: 'pending',
        allowedFrom: ['done'],
        allowTerminal: true,
      }),
    )
    await expectClosed(() =>
      databaseSessionFor(db).transaction(async (tx) => {
        await fenceTaskWrite(tx, { taskId: 'task-1' })
        await lockNodeRunTaskRootInTx(tx, 'run-1')
        return setNodeRunStatusTx({
          tx,
          nodeRunId: 'run-1',
          to: 'pending',
          allowedFrom: ['done'],
          allowTerminal: true,
        })
      }),
    )
  })

  test('explicit reopen clearing the closed fence permits later lifecycle work', async () => {
    const db = await fixture(harness.db, 'pending')
    await patchTaskFixture(db, { id: 'task-1' }, { sourceTerminationFence: null })
    await expect(
      transitionNodeRunStatus({ db, nodeRunId: 'run-1', event: { kind: 'mark-running' } }),
    ).resolves.toEqual({ from: 'pending', to: 'running' })
  })
})
