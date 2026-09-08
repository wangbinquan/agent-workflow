// RFC-159 T3 (PR-3a) — tasks.scheduled_task_id link plumbing.
//
// Locks: the column round-trips through getTask / listTasks summaries, and
// listTasks({ scheduledTaskId }) filters to a schedule's run history. The
// startTask threading (deps.scheduledTaskId → row) is source-locked here and
// exercised end-to-end by the scheduler fire path.
import { describeEachProvider } from './helpers/eachProvider'
import type { ProviderNeutralDatabase } from '../src/db/query'
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { tasks, workflows } from '../src/db/schema'
import { getTask, listTasks } from '../src/services/task'

async function seedTask(
  db: ProviderNeutralDatabase,
  id: string,
  scheduledTaskId: string | null,
): Promise<void> {
  await db
    .insert(workflows)
    .values({ id: `wf-${id}`, name: `wf-${id}`, description: '', definition: '{}' })
    .onConflictDoNothing()
  await db.insert(tasks).values({
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

    test('listTasks({ scheduledTaskId }) returns only that schedule’s runs; summaries expose it', async () => {
      const db = harness.db
      await seedTask(db, 't-a', 'sched-1')
      await seedTask(db, 't-b', 'sched-1')
      await seedTask(db, 't-c', 'sched-2')
      await seedTask(db, 't-manual', null)

      const runs = await listTasks(db, { scheduledTaskId: 'sched-1' })
      expect(new Set(runs.map((t) => t.id))).toEqual(new Set(['t-a', 't-b']))
      expect(runs.every((t) => t.scheduledTaskId === 'sched-1')).toBe(true)

      // Unfiltered list still returns everything (filter is opt-in).
      expect((await listTasks(db)).length).toBe(4)
    })
  })

  test('startTask stamps deps.scheduledTaskId onto the row (source lock)', () => {
    const src = readFileSync(resolve(import.meta.dir, '..', 'src', 'services', 'task.ts'), 'utf-8')
    // The stamp lives in the single task INSERT so it is atomic with row creation.
    expect(src).toContain('scheduledTaskId: deps.scheduledTaskId ?? null')
    // StartTaskDeps declares the field so the scheduler can pass it.
    expect(src).toContain('scheduledTaskId?: string')
  })
})
