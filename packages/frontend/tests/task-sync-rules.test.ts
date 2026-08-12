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

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import type { TaskWsMessage } from '@agent-workflow/shared'
import { buildTaskSyncRules } from '@/hooks/useTaskSync'
import { TASK_QUERY_KEYS } from '../src/lib/query-keys'
import { taskChildrenQueryKey } from '@/hooks/useTaskChildren'
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
    expect(keys).toContainEqual(TASK_QUERY_KEYS.nodeRuns(TASK))
    expect(keys).toContainEqual(TASK_QUERY_KEYS.questions(TASK))
    expect(keys).toContainEqual(TASK_QUERY_KEYS.clarifyDirectives(TASK))
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
    expect(keys).toEqual([TASK_QUERY_KEYS.nodeRuns(TASK)])
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

// RFC-245 — the direct-children list must be re-validated by WS, not left to a
// poll that switches itself off.
//
// `useTaskChildren` keys the child list under ['tasks','children',parentId].
// That is NOT a suffix of ['tasks', taskId], so react-query's prefix matching
// means none of the keys this table used to emit could ever refresh it — and
// the query's own refetchInterval turns OFF when the list is empty. Opening a
// parent whose call node had not dispatched yet therefore froze the list at []
// forever, and every consumer that treats "loaded and absent" as proof (the
// ChildTaskLink placeholder, and RFC-245's canvas click affordance) stayed wrong
// for the life of the page. A call node stamps child_task_id and flips its row
// to running, so `node.status` is exactly the frame that invalidates it.
describe('buildTaskSyncRules — child-task list re-validation (RFC-245)', () => {
  test('node.status invalidates the children list key', () => {
    const keys = keysFor({
      id: 5,
      type: 'node.status',
      nodeRunId: 'r1',
      nodeId: 'n1',
      status: 'running',
    })
    expect(keys).toContainEqual(taskChildrenQueryKey(TASK))
  })

  test('the children key is not reachable through the other invalidated prefixes', () => {
    // Guards the reason this rule has to exist at all: if someone "simplifies"
    // it away believing TASK_QUERY_KEYS.detail(TASK) already covers it, this fails.
    const childrenKey = taskChildrenQueryKey(TASK) as readonly unknown[]
    expect(childrenKey[0]).toBe('tasks')
    expect(childrenKey[1]).not.toBe(TASK)
  })

  test('task terminal transitions refresh the children list too', () => {
    for (const frame of [
      { id: 6, type: 'task.status', status: 'running' },
      { id: 7, type: 'task.done', status: 'done' },
    ] as TaskWsMessage[]) {
      expect(keysFor(frame)).toContainEqual(taskChildrenQueryKey(TASK))
    }
  })
})

// ---------------------------------------------------------------------------
// RFC-286 F4 —— 规则表零字面锁：三张 WS 失效规则表（useTaskSync / useTasksSync /
// useClarifyWs）里不得再出现字符串字面 queryKey（['tasks'… / ['reviews'… /
// ['clarify'… / ['task-…），一律走 lib/query-keys 工厂或既有单源
// （workgroupRoomKey / taskChildrenQueryKey）。字面 key 与 route 侧靠肉眼同步，
// 改一边即静默失联（只剩轮询兜底）。实现门双路（路 1 P1-1 / 路 2 P2-1）把锁面
// 从单文件扩成全规则表。
// ---------------------------------------------------------------------------

describe('RFC-286 F4 — WS 规则表零字符串字面 queryKey', () => {
  for (const hook of ['useTaskSync.ts', 'useTasksSync.ts', 'useClarifyWs.ts']) {
    test(`${hook} 源码零字面 key（注释行除外）`, () => {
      const src = readFileSync(resolve(import.meta.dirname, `../src/hooks/${hook}`), 'utf8')
      const offenders = src
        .split('\n')
        .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
        .filter((line) =>
          /\['(tasks|reviews|clarify|task-questions|task-clarify-directives)'/.test(line),
        )
      expect(offenders).toEqual([])
    })
  }
})
