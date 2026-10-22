// RFC-370 §9.2 V3 — Task Execution's volume-use facts for Source Control's
// hosted parent lifecycle: a CS parent stays running while an AW task bound to
// its volume is pending/running or an execution on it has not settled; a task
// that waits for a person (or finished) no longer keeps it running. Logical
// children map to the physical owner named by their workspace reference.
import { tablesOf } from '@/platform/persistence/sessionTables'
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { createHostedVolumeActivity } from '@/modules/task-execution/infrastructure/crewstation/volumeActivity'
import type { HostedExecutionBinding } from '@/modules/task-execution/infrastructure/crewstation/executionStore'
import { describeEachProvider } from './helpers/eachProvider'
import { seedTask } from './helpers/questionDispatchFixture'

describeEachProvider('RFC-370 hosted volume activity', (harness) => {
  const binding = (taskId: string): HostedExecutionBinding =>
    ({ executionId: `agent:${taskId}:run`, taskId }) as HostedExecutionBinding

  test('active tasks and unsettled executions keep their physical owner in use', async () => {
    for (const id of ['t-run', 't-pend', 't-child', 't-human', 't-done', 't-bound'])
      await seedTask(harness.db, id)
    const status = async (id: string, value: string, worktreePath?: string) => {
      const { tasks } = tablesOf(harness.db)
      return harness.db
        .update(tasks)
        .set({ status: value as never, ...(worktreePath === undefined ? {} : { worktreePath }) })
        .where(eq(tasks.id, id))
    }
    await status('t-run', 'running', 'cs-workspace:t-run/worktrees/t-run')
    await status('t-pend', 'pending', '')
    // An inherited child works in its parent's physical volume.
    await status('t-child', 'running', 'cs-workspace:t-run/worktrees/t-child')
    await status('t-human', 'awaiting_human', 'cs-workspace:t-human/worktrees/t-human')
    await status('t-done', 'done', 'cs-workspace:t-done/worktrees/t-done')
    await status('t-bound', 'awaiting_human', 'cs-workspace:t-parent/worktrees/t-bound')
    const activity = createHostedVolumeActivity({
      db: harness.db,
      store: { unsettled: async () => [binding('t-bound'), binding('system:intent')] },
    })
    expect([...(await activity.activeVolumeOwners())].sort()).toEqual(
      // t-run (itself + child), t-pend (no volume yet: its own id), the
      // parent volume of the unsettled t-bound execution, a shared owner.
      ['system:intent', 't-parent', 't-pend', 't-run'].sort(),
    )
  })

  test('no active task and no unsettled execution means no volume is in use', async () => {
    await seedTask(harness.db, 't-idle')
    const { tasks } = tablesOf(harness.db)
    await harness.db.update(tasks).set({ status: 'done' }).where(eq(tasks.id, 't-idle'))
    const activity = createHostedVolumeActivity({
      db: harness.db,
      store: { unsettled: async () => [] },
    })
    expect((await activity.activeVolumeOwners()).size).toBe(0)
  })
})
