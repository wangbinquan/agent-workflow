// Regression lock (RFC-179) — the workgroup chat room's live indicators
// (执行中 pills / active-execution rows / 点成员看当前 session) derive from
// node_run STATUS, which only moves via `node.status` WS frames, NOT the wg.*
// frames. useTaskSync therefore MUST invalidate the room aggregate key on
// node.status; without it the room looks frozen the whole time a leader/member
// opencode session is thinking (no message posted yet) and only catches up on
// F5 / the 15s poll — the exact "工作组聊天室不实时更新" report this fixes.
//
// The rules table is exported as the pure `buildTaskSyncRules(taskId)` for
// precisely this reason (the hook itself needs a socket + render to exercise).
// node.event (high-frequency streaming) must stay OFF the room key so a live
// run doesn't refetch the aggregate on every token.

import { describe, expect, test } from 'vitest'
import type { TaskWsMessage } from '@agent-workflow/shared'
import { buildTaskSyncRules } from '@/hooks/useTaskSync'
import { workgroupRoomKey } from '@/lib/workgroup-room'

const TASK = 't1'

/** Fire the rule registered for `msg.type` and return the invalidated keys. */
function keysFor(msg: TaskWsMessage): readonly unknown[] {
  const rules = buildTaskSyncRules(TASK) as Record<
    string,
    ((m: TaskWsMessage) => readonly unknown[] | void) | undefined
  >
  return rules[msg.type]?.(msg) ?? []
}

describe('buildTaskSyncRules — workgroup room liveness', () => {
  test('node.status invalidates the workgroup room aggregate (RFC-179 executing indicators)', () => {
    const keys = keysFor({
      id: 1,
      type: 'node.status',
      nodeRunId: 'r1',
      nodeId: 'n1',
      status: 'running',
    })
    expect(keys).toContainEqual(workgroupRoomKey(TASK))
    // …without dropping the node-runs / question / clarify-directive keys it
    // has always refreshed.
    expect(keys).toContainEqual(['tasks', TASK, 'node-runs'])
    expect(keys).toContainEqual(['task-questions', TASK])
    expect(keys).toContainEqual(['task-clarify-directives', TASK])
  })

  test('node.event does NOT touch the room key (streaming stays cheap)', () => {
    const keys = keysFor({
      id: 2,
      type: 'node.event',
      nodeRunId: 'r1',
      ts: 0,
      kind: 'text',
      payload: '',
    })
    expect(keys).not.toContainEqual(workgroupRoomKey(TASK))
    expect(keys).toEqual([['tasks', TASK, 'node-runs']])
  })

  test('each wg.* frame refetches the room aggregate', () => {
    const frames: TaskWsMessage[] = [
      { id: -1, type: 'wg.message.created', messageId: 'm', kind: 'chat' },
      { id: -1, type: 'wg.assignment.updated', assignmentId: 'a', status: 'dispatched' },
      { id: -1, type: 'wg.gate.updated', awaitingConfirmation: false },
    ]
    for (const f of frames) {
      expect(keysFor(f)).toContainEqual(workgroupRoomKey(TASK))
    }
  })

  test('task.status / task.done also refresh the room (dw phase slot lives there)', () => {
    expect(keysFor({ id: 3, type: 'task.status', status: 'running' })).toContainEqual(
      workgroupRoomKey(TASK),
    )
    expect(keysFor({ id: 4, type: 'task.done', status: 'done' })).toContainEqual(
      workgroupRoomKey(TASK),
    )
  })
})
