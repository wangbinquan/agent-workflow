// RFC-303: every node-run writer must honor the task-owned terminal fence.
// Lock all three lifecycle APIs so review/human repair and retry paths cannot
// revive external work after an MR / PR terminal fact committed.
import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { resolve } from 'node:path'

import { createInMemoryDb } from '@/db/client'
import { nodeRuns, tasks, workflows } from '@/db/schema'
import { dbTxSync } from '@/db/txSync'
import { setNodeRunStatus, setNodeRunStatusTx, transitionNodeRunStatus } from '@/services/lifecycle'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

async function fixture(status: 'pending' | 'done') {
  const db = createInMemoryDb(MIGRATIONS)
  await db.insert(workflows).values({ id: 'workflow-1', name: 'workflow', definition: '{}' })
  await db.insert(tasks).values({
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
  await db.insert(nodeRuns).values({
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

describe('RFC-303 node-run terminal fence', () => {
  test('named transition cannot dispatch a pending node', async () => {
    const db = await fixture('pending')
    await expectClosed(() =>
      transitionNodeRunStatus({ db, nodeRunId: 'run-1', event: { kind: 'mark-running' } }),
    )
    expect((await db.select().from(nodeRuns).where(eq(nodeRuns.id, 'run-1')))[0]?.status).toBe(
      'pending',
    )
  })

  test('async and transactional lower-level revival paths fail with the stable code', async () => {
    const db = await fixture('done')
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
      dbTxSync(db, (tx) =>
        setNodeRunStatusTx({
          tx,
          nodeRunId: 'run-1',
          to: 'pending',
          allowedFrom: ['done'],
          allowTerminal: true,
        }),
      ),
    )
  })

  test('explicit reopen clearing the closed fence permits later lifecycle work', async () => {
    const db = await fixture('pending')
    await db.update(tasks).set({ sourceTerminationFence: null }).where(eq(tasks.id, 'task-1'))
    await expect(
      transitionNodeRunStatus({ db, nodeRunId: 'run-1', event: { kind: 'mark-running' } }),
    ).resolves.toEqual({ from: 'pending', to: 'running' })
  })
})
