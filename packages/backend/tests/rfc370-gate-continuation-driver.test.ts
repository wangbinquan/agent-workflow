// RFC-370 hosted acceptance (2026-10-18) — the PostgreSQL daemon's gate
// continuation worker waits for this process's driver to release the task.
//
// WHY THIS FILE EXISTS (regression intent): a clarify answered while other
// branches of the task still ran made the continuation worker try to claim the
// task every second; each attempt was an owner conflict ("already has owner
// state 'claimed'") logged as a warning, about a thousand of them while the
// parked driver drained its admitted work. The continuation is now claimed
// only once the task's driver in this process has released it (SQLite defers
// behind `awaitTaskDriverIdle` the same way).
import { expect, test } from 'bun:test'
import { createGateContinuationDriver } from '@/modules/task-execution/application/drive/gateContinuationDriver'
import type { TaskDriveSubmission } from '@/modules/task-execution/application/drive/taskDriveTypes'

function fixture(driving: Set<string>) {
  const submitted: TaskDriveSubmission[] = []
  const drive = createGateContinuationDriver({
    isDriving: (taskId) => driving.has(taskId),
    coordinator: {
      async submit(request) {
        submitted.push(request)
        return { kind: 'accepted', taskId: request.taskId }
      },
    },
  })
  return { drive, submitted }
}

test('a task this process still drives is left to the next worker cycle', async () => {
  const f = fixture(new Set(['t1']))
  await f.drive({ taskId: 't1', continuationRef: 'c1' })
  expect(f.submitted).toEqual([])
})

test('a released task submits its exact continuation in the background', async () => {
  const driving = new Set(['t1'])
  const f = fixture(driving)
  await f.drive({ taskId: 't1', continuationRef: 'c1' })
  driving.delete('t1')
  await f.drive({ taskId: 't1', continuationRef: 'c1' })
  expect(f.submitted).toEqual([{ taskId: 't1', intentId: 'c1', completionMode: 'background' }])
})

test('another task is not held back by a driven one', async () => {
  const f = fixture(new Set(['t1']))
  await f.drive({ taskId: 't2', continuationRef: 'c2' })
  expect(f.submitted).toEqual([{ taskId: 't2', intentId: 'c2', completionMode: 'background' }])
})
