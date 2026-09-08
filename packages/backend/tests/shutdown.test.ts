// P-4-06: graceful shutdown budget.
//
// We don't spawn a real daemon process here — the budget loop polls the DB
// for tasks in `running` and flips survivors to `interrupted`. We seed a
// task that stays running and verify the survivor path.

import { describeEachProvider } from './helpers/eachProvider'
import type { ProviderNeutralDatabase } from '../src/db/query'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ulid } from 'ulid'
import { tasks, workflows } from '../src/db/schema'
import { gracefulShutdown } from '../src/services/shutdown'
import { taskExecutionModule } from '../src/modules/task-execution/composition'
import { createTaskExecutionPersistence } from '../src/modules/task-execution/composition/taskExecutionPersistence'

interface Harness {
  db: ProviderNeutralDatabase
  appHome: string
  cleanup: () => void
}

function buildHarness(db: ProviderNeutralDatabase): Harness {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-shutdown-'))
  return {
    db,
    appHome,
    cleanup: () => rmSync(appHome, { recursive: true, force: true }),
  }
}

async function seedRunning(db: ProviderNeutralDatabase): Promise<string> {
  const workflowId = ulid()
  const taskId = ulid()
  await db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    definition: '{}',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  await db.insert(tasks).values({
    name: 'fixture-task',

    id: taskId,
    // Preserve the root lineage supplied by the original SQLite INSERT trigger.
    executionLineageId: taskId,
    lineageSlotPathJson: JSON.stringify([
      { stableNodeKey: 'task-root', frozenOccurrenceKey: taskId, workflowRevision: null },
    ]),
    workflowId,
    workflowSnapshot: '{}',
    repoPath: '/tmp/repo',
    worktreePath: '/tmp/wt',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
  })
  return taskId
}

describeEachProvider('gracefulShutdown', (harness) => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness(harness.db)
  })
  afterEach(() => {
    taskExecutionModule.resetForTesting()
    h.cleanup()
  })

  test('returns immediately when no tasks are running', async () => {
    const t0 = Date.now()
    const persistence = createTaskExecutionPersistence(h.db)
    await gracefulShutdown(
      {
        controller: {
          async shutdownActive() {
            return []
          },
        },
        operations: persistence.shutdown,
        recovery: persistence.recoveryAdministration,
      },
      5000,
    )
    expect(Date.now() - t0).toBeLessThan(500)
  })

  test('flips survivors to interrupted after budget elapses', async () => {
    const taskId = await seedRunning(h.db)
    // No AbortController registered — abortAllActiveTasks is a no-op, and
    // the row stays running. After the short budget, the survivor path
    // marks it interrupted.
    const persistence = createTaskExecutionPersistence(h.db)
    await gracefulShutdown(
      {
        controller: {
          async shutdownActive() {
            return []
          },
        },
        operations: persistence.shutdown,
        recovery: persistence.recoveryAdministration,
      },
      300,
    )
    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('interrupted')
    // RFC-202 T4: survivors stamp DAEMON_RESTART_ERROR_SUMMARY ('daemon-restart')
    // — the exact summary autoResume's boot pass matches — instead of the old
    // 'daemon-shutdown' string that no recovery path ever picked up.
    expect(t?.errorSummary).toBe('daemon-restart')
  })
})
