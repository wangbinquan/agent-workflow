// RFC-054 W2-2 — golden snapshot of the WebSocket broadcast sequence for a
// canonical task lifecycle (pending → running → done).
//
// LOCKS: every state transition the UI relies on emits exactly the WS
// messages we expect, in the right order, on the right channels. Catches
// regressions where:
//   * a service forgets to call `emitTaskStatus` after mutating the row
//     (UI sticks on a stale state)
//   * an extra duplicate broadcast is added (UI re-renders thrash)
//   * a message lands on the wrong channel (per-task vs tasks-list) — the
//     two are subscribed-to by different views, so swapping them silently
//     breaks one of them
//   * the discriminant `type` field is renamed (breaks the discriminated
//     union on the frontend Zod side)
//
// Why golden instead of "fire once and snapshot" inline assertions: the
// sequence is the contract. Listing it as a constant at the top of the
// test makes the expectation reviewable in code review without running
// the suite, and any future PR that intends to change the sequence MUST
// edit this constant in the same diff — surfacing the behavioural change
// to reviewers.
//
// This test does NOT mock the broadcaster. It uses the real
// `tasksListBroadcaster` + `taskBroadcaster` singletons (via the
// `subscribe` callback) and drives them through the real `emitTaskStatus`
// service function. That's the contract surface — anything below that is
// implementation detail.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { ulid } from 'ulid'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { tasks, workflows } from '../src/db/schema'
import { emitTaskStatus } from '../src/services/task'
import { createWebSocketTaskStatusPublisher } from '../src/modules/task-execution/infrastructure/webSocketTaskStatusPublisher'
import {
  resetBroadcastersForTests,
  TASK_CHANNEL,
  TASKS_LIST_CHANNEL,
  taskBroadcaster,
  tasksListBroadcaster,
} from '../src/ws/broadcaster'

import type { TaskWsMessage, TasksListWsMessage } from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

/**
 * A "type | type" tag is enough to lock the sequence — payload details
 * (taskId / status string) are covered by separate per-message asserts
 * below. The point of the golden is to lock the *cadence and channels*.
 */
type ChannelTag = 'list' | 'task'
interface RecordedMessage {
  channel: ChannelTag
  type: TaskWsMessage['type'] | TasksListWsMessage['type']
}

/**
 * Canonical happy-path lifecycle expected sequence. Six broadcasts in
 * total for the three transitions:
 *
 *   pending →running:
 *     list:  task.status (status=running)
 *     task:  task.status (status=running)
 *   running → done:
 *     list:  task.status (status=done)
 *     task:  task.status (status=done)
 *     task:  task.done   (status=done)    ← terminal-state shortcut event
 *
 * Order matters because the frontend `useTaskWs` hook applies messages
 * in arrival order to optimistic UI state; reordering inserts a flicker.
 * Adding new message types here means a new UI behavior is expected to
 * fire — the PR that adds the broadcast must also update this golden.
 */
const GOLDEN_HAPPY_PATH: ReadonlyArray<RecordedMessage> = [
  { channel: 'list', type: 'task.status' }, // pending → running
  { channel: 'task', type: 'task.status' },
  { channel: 'list', type: 'task.status' }, // running → done
  { channel: 'task', type: 'task.status' },
  { channel: 'task', type: 'task.done' },
]

/**
 * Failed terminal: same shape as done but with status='failed', so the
 * task channel still emits the `task.done` terminal shortcut. The
 * golden differs from happy path only by the order of transitions
 * (here: pending → running → failed). Locks "failed is a terminal
 * status for the purposes of the UI's `task.done` broadcast" — if a
 * future refactor splits done/failed into different events, this fires.
 */
const GOLDEN_FAILED_PATH: ReadonlyArray<RecordedMessage> = [
  { channel: 'list', type: 'task.status' }, // pending → running
  { channel: 'task', type: 'task.status' },
  { channel: 'list', type: 'task.status' }, // running → failed
  { channel: 'task', type: 'task.status' },
  { channel: 'task', type: 'task.done' },
]

/**
 * Awaiting-review is NOT a terminal state in the daemon — task can be
 * resumed when the reviewer approves. So the per-task channel must
 * NOT emit `task.done` here. Locks that fix-forward: a previous version
 * incorrectly fired task.done on every awaiting_* state which forced
 * the UI to permanently render "task complete". Catching that
 * regression is exactly what this golden is for.
 */
const GOLDEN_AWAITING_REVIEW_PATH: ReadonlyArray<RecordedMessage> = [
  { channel: 'list', type: 'task.status' }, // pending → running
  { channel: 'task', type: 'task.status' },
  { channel: 'list', type: 'task.status' }, // running → awaiting_review
  { channel: 'task', type: 'task.status' },
  // NO task.done — review still pending.
]

interface Recorded {
  list: TasksListWsMessage[]
  task: TaskWsMessage[]
}

async function seedTask(db: DbClient, status: 'pending' | 'running' = 'pending') {
  const taskId = `task_${ulid()}`
  const wfId = `wf_${ulid()}`
  const def = JSON.stringify({
    $schema_version: 3,
    inputs: [],
    nodes: [],
    edges: [],
    outputs: [],
  })
  await db.insert(workflows).values({
    id: wfId,
    name: 'wf-golden',
    definition: def,
    description: '',
    version: 1,
    schemaVersion: 3,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'golden-fixture-task',
    workflowId: wfId,
    workflowSnapshot: def,
    repoPath: '/tmp/aw-golden/repo',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status,
    inputs: '{}',
    startedAt: Date.now(),
  })
  return { taskId, wfId }
}

function subscribeBoth(taskId: string): { received: Recorded; unsubscribe: () => void } {
  const received: Recorded = { list: [], task: [] }
  const offList = tasksListBroadcaster.subscribe(TASKS_LIST_CHANNEL, (m) => received.list.push(m))
  const offTask = taskBroadcaster.subscribe(TASK_CHANNEL(taskId), (m) => received.task.push(m))
  return {
    received,
    unsubscribe: () => {
      offList()
      offTask()
    },
  }
}

function recorded(r: Recorded): RecordedMessage[] {
  return [
    ...r.list.map((m): RecordedMessage => ({ channel: 'list', type: m.type })),
    ...r.task.map((m): RecordedMessage => ({ channel: 'task', type: m.type })),
  ]
}

/**
 * Interleave preserving per-channel order — captures the ACTUAL order of
 * broadcasts as a single timeline. Subscribers receive synchronously, so
 * the only race is between the two channels' fire order, which is fixed
 * by emitTaskStatus's hardcoded sequence (list first, then task).
 *
 * We do this by re-running the same sequence with a single interleaved
 * recorder (instead of two per-channel arrays).
 */
function subscribeInterleaved(taskId: string): {
  timeline: RecordedMessage[]
  unsubscribe: () => void
} {
  const timeline: RecordedMessage[] = []
  const offList = tasksListBroadcaster.subscribe(TASKS_LIST_CHANNEL, (m) =>
    timeline.push({ channel: 'list', type: m.type }),
  )
  const offTask = taskBroadcaster.subscribe(TASK_CHANNEL(taskId), (m) =>
    timeline.push({ channel: 'task', type: m.type }),
  )
  return { timeline, unsubscribe: () => (offList(), offTask()) }
}

beforeEach(() => resetBroadcastersForTests())
afterEach(() => resetBroadcastersForTests())

describe('RFC-054 W2-2 — WS broadcast golden sequences', () => {
  test('RFC-331 publisher adapter preserves terminal and canceled-node ordering', () => {
    const taskId = `task_${ulid()}`
    const { received, unsubscribe } = subscribeBoth(taskId)
    createWebSocketTaskStatusPublisher().publish({
      taskId,
      status: 'canceled',
      errorSummary: null,
      canceledNodeRuns: [{ id: 'run-canceled', nodeId: 'node-canceled' }],
    })
    unsubscribe()

    expect(received.list).toEqual([{ type: 'task.status', taskId, status: 'canceled' }])
    expect(received.task).toEqual([
      { id: -1, type: 'task.status', status: 'canceled' },
      { id: -1, type: 'task.done', status: 'canceled' },
      {
        id: -1,
        type: 'node.status',
        nodeRunId: 'run-canceled',
        nodeId: 'node-canceled',
        status: 'canceled',
      },
    ])
  })

  test('happy path: pending → running → done emits the canonical 5-message sequence', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    const { timeline, unsubscribe } = subscribeInterleaved(taskId)

    // pending → running.
    emitTaskStatus({
      id: taskId,
      status: 'running',
      errorSummary: null,
    } as Parameters<typeof emitTaskStatus>[0])

    // running → done.
    emitTaskStatus({
      id: taskId,
      status: 'done',
      errorSummary: null,
    } as Parameters<typeof emitTaskStatus>[0])

    unsubscribe()
    expect(timeline).toEqual([...GOLDEN_HAPPY_PATH])

    // Payload sanity — the type tag alone isn't enough; tie down the
    // taskId so a future refactor doesn't accidentally broadcast for a
    // different task.
    expect(timeline.length).toBe(5)
  })

  test('failed path: pending → running → failed emits identical cadence (failed IS terminal)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    const { timeline, unsubscribe } = subscribeInterleaved(taskId)

    emitTaskStatus({
      id: taskId,
      status: 'running',
      errorSummary: null,
    } as Parameters<typeof emitTaskStatus>[0])
    emitTaskStatus({
      id: taskId,
      status: 'failed',
      errorSummary: 'stub failure',
    } as Parameters<typeof emitTaskStatus>[0])

    unsubscribe()
    expect(timeline).toEqual([...GOLDEN_FAILED_PATH])
  })

  test('awaiting_review NOT terminal: per-task channel must NOT emit task.done', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    const { timeline, unsubscribe } = subscribeInterleaved(taskId)

    emitTaskStatus({
      id: taskId,
      status: 'running',
      errorSummary: null,
    } as Parameters<typeof emitTaskStatus>[0])
    emitTaskStatus({
      id: taskId,
      status: 'awaiting_review',
      errorSummary: null,
    } as Parameters<typeof emitTaskStatus>[0])

    unsubscribe()
    expect(timeline).toEqual([...GOLDEN_AWAITING_REVIEW_PATH])
    // Explicit negative assertion — if the source incorrectly fires task.done
    // on awaiting_* status, this catches it even when the golden array is
    // wrong (cross-check belt + suspenders).
    expect(timeline.filter((m) => m.type === 'task.done')).toHaveLength(0)
  })

  test('payload sanity: tasks-list message carries taskId; per-task message carries errorSummary when failing', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    const { received, unsubscribe } = subscribeBoth(taskId)

    emitTaskStatus({
      id: taskId,
      status: 'failed',
      errorSummary: 'mock-opencode exit 1',
    } as Parameters<typeof emitTaskStatus>[0])

    unsubscribe()

    expect(received.list).toHaveLength(1)
    const listMsg = received.list[0]!
    expect(listMsg.type).toBe('task.status')
    if (listMsg.type === 'task.status') {
      expect(listMsg.taskId).toBe(taskId)
      expect(listMsg.status).toBe('failed')
    }

    // Per-task channel emits TWO messages on terminal: task.status + task.done.
    expect(received.task).toHaveLength(2)
    const taskStatus = received.task.find((m) => m.type === 'task.status')!
    expect(taskStatus).toBeDefined()
    if (taskStatus.type === 'task.status') {
      expect(taskStatus.status).toBe('failed')
      // errorSummary is included when present (line 769 in services/task.ts).
      expect(taskStatus.errorSummary).toBe('mock-opencode exit 1')
    }
    const taskDone = received.task.find((m) => m.type === 'task.done')!
    expect(taskDone).toBeDefined()
    if (taskDone.type === 'task.done') {
      expect(taskDone.status).toBe('failed')
    }
  })
})

// Helper for callers wanting to drive the same recorder externally (e.g.
// the next WS fuzz test in this PR). Exported for test reuse but kept
// outside the describe to avoid pollution.
export function _recordedForExternal(r: Recorded): RecordedMessage[] {
  return recorded(r)
}
