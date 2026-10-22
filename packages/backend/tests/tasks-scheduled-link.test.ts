// RFC-395 II-pre：生产启动 / 延续依赖及工作区租约改接线，保留既有断言。
// RFC-159 T3 (PR-3a) — tasks.scheduled_task_id link plumbing.
//
// Locks: the column round-trips through getTask / listTasks summaries, and
// taskListSummariesProjection({ scheduledTaskId }) filters to a schedule's run history. The
// startTask threading (deps.scheduledTaskId → row) is source-locked here and
// exercised end-to-end by the scheduler fire path.
import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { describeEachProvider } from './helpers/eachProvider'
import { taskListSummariesProjection } from '../src/modules/task-execution/infrastructure/taskRouteOperations'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { getTask } from '../src/services/task'

async function seedTask(
  db: PersistenceDb,
  id: string,
  scheduledTaskId: string | null,
): Promise<void> {
  const { workflows, tasks } = tablesOf(db)
  await db
    .insert(workflows)
    .values({ id: `wf-${id}`, name: `wf-${id}`, description: '', definition: '{}' })
    .onConflictDoNothing()
  await insertOne(db, tasks, {
    id,
    name: `task-${id}`,
    workflowId: `wf-${id}`,
    workflowSnapshot: '{}',
    repoPath: '/tmp/repo',
    worktreePath: '/tmp/wt',
    baseBranch: 'main',
    branch: `agent-workflow/${id}`,
    status: 'done',
    inputs: '{}',
    startedAt: 1,
    scheduledTaskId,
  })
}

describe('RFC-159 — tasks.scheduled_task_id link', () => {
  describeEachProvider('database behavior', (harness) => {
    test('round-trips through getTask (scheduled → id; manual → null)', async () => {
      const db = harness.db
      await seedTask(db, 't-sched', 'sched-1')
      await seedTask(db, 't-manual', null)
      expect((await getTask(db, 't-sched'))?.scheduledTaskId).toBe('sched-1')
      expect((await getTask(db, 't-manual'))?.scheduledTaskId ?? null).toBe(null)
    })

    test('taskListSummariesProjection({ scheduledTaskId }) returns only that schedule’s runs; summaries expose it', async () => {
      const db = harness.db
      await seedTask(db, 't-a', 'sched-1')
      await seedTask(db, 't-b', 'sched-1')
      await seedTask(db, 't-c', 'sched-2')
      await seedTask(db, 't-manual', null)

      const runs = await taskListSummariesProjection(db, { scheduledTaskId: 'sched-1' })
      expect(new Set(runs.map((t) => t.id))).toEqual(new Set(['t-a', 't-b']))
      expect(runs.every((t) => t.scheduledTaskId === 'sched-1')).toBe(true)

      // Unfiltered list still returns everything (filter is opt-in).
      expect((await taskListSummariesProjection(db, {})).length).toBe(4)
    })
  })

  test('production root launch stamps invoker schedule metadata in the task INSERT (source lock)', () => {
    const src = readFileSync(
      resolve(
        import.meta.dir,
        '../src/modules/task-execution/infrastructure/taskRouteLaunchOperations.ts',
      ),
      'utf-8',
    )
    // The stamp lives in the single task INSERT so it is atomic with row creation.
    expect(src).toContain('scheduledTaskId: metadata.scheduledTaskId')
    expect(src).toContain(
      "scheduledTaskId: invoker.type === 'scheduled' ? invoker.scheduledTaskId : null",
    )
  })
})
