// RFC-061 follow-up — writeEvents fans out one task.event.appended WS
// frame per appended event after commit.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { tasks, workflows } from '../src/db/schema'
import { writeEvents } from '../src/services/writeEvents'
import { resetBroadcastersForTests, taskBroadcaster, TASK_CHANNEL } from '../src/ws/broadcaster'
import type { TaskWsMessage } from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

async function seedTask(db: DbClient): Promise<string> {
  const wfId = ulid()
  await db.insert(workflows).values({
    id: wfId,
    name: 'wf',
    definition: '{}',
  })
  const taskId = ulid()
  await db.insert(tasks).values({
    id: taskId,
    name: 'fixture-task',
    workflowId: wfId,
    workflowSnapshot: '{}',
    repoPath: '/tmp/aw',
    worktreePath: '/tmp/aw-wt',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
  })
  return taskId
}

describe('writeEvents → WS broadcaster', () => {
  beforeEach(() => resetBroadcastersForTests())
  afterEach(() => resetBroadcastersForTests())

  test('each appended event produces one task.event.appended frame', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    const received: TaskWsMessage[] = []
    const unsub = taskBroadcaster.subscribe(TASK_CHANNEL(taskId), (msg) => {
      received.push(msg)
    })

    await writeEvents(db, [
      {
        taskId,
        kind: 'logical-run-created',
        payload: {},
        actor: 'system',
        nodeId: 'n1',
        loopIter: 0,
        shardKey: '',
        iter: 0,
      },
      {
        taskId,
        kind: 'logical-run-completed',
        payload: {},
        actor: 'system',
        nodeId: 'n1',
        loopIter: 0,
        shardKey: '',
        iter: 0,
      },
    ])

    const appended = received.filter((m) => m.type === 'task.event.appended')
    expect(appended.length).toBe(2)
    expect(appended[0]?.type === 'task.event.appended' && appended[0].kind).toBe(
      'logical-run-created',
    )
    expect(appended[1]?.type === 'task.event.appended' && appended[1].kind).toBe(
      'logical-run-completed',
    )
    unsub()
  })

  test('subscribers to a different task do not receive frames', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskA = await seedTask(db)
    const taskB = await seedTask(db)
    const aReceived: TaskWsMessage[] = []
    const bReceived: TaskWsMessage[] = []
    taskBroadcaster.subscribe(TASK_CHANNEL(taskA), (m) => aReceived.push(m))
    taskBroadcaster.subscribe(TASK_CHANNEL(taskB), (m) => bReceived.push(m))

    await writeEvents(db, [
      {
        taskId: taskA,
        kind: 'task-started',
        payload: {},
        actor: 'system',
      },
    ])

    expect(aReceived.length).toBe(1)
    expect(bReceived.length).toBe(0)
  })
})
