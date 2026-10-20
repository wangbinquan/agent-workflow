// RFC-374 T8/T10: navigation, history and inherited memory follow mint seq even when IDs run backwards.
import { describe, expect, test } from 'vitest'
import { NodeRunSchema, type NodeRun, type WorkgroupRunEntry } from '@agent-workflow/shared'
import { deriveCallNodeNav, deriveCurrentCallNodeRun } from '../src/lib/call-node-nav'
import { deriveClarifyNodeNav } from '../src/lib/clarify-node-nav'
import { deriveReviewNodeNav } from '../src/lib/review-node-nav'
import {
  clarifyRoundForRun,
  displayRetryForRun,
  groupHistoryByFrame,
  nodeRunHistory,
} from '../src/lib/node-history'
import { findFirstAttemptSibling } from '../src/lib/injected-memories-card'
import { buildRoomTimeline } from '../src/lib/workgroup-room'

function run(id: string, seq: number | null, extra: Partial<NodeRun> = {}): NodeRun {
  return NodeRunSchema.parse({
    id,
    seq,
    taskId: 't',
    nodeId: 'n',
    parentNodeRunId: null,
    iteration: 0,
    shardKey: null,
    retryIndex: 0,
    status: 'done',
    startedAt: null,
    finishedAt: null,
    pid: null,
    exitCode: null,
    errorMessage: null,
    promptText: null,
    tokInput: null,
    tokOutput: null,
    tokTotal: null,
    tokCacheCreate: null,
    tokCacheRead: null,
    ...extra,
  })
}
describe('RFC-374 inverted ID consumers', () => {
  test('all navigation follows the newest stamp, including a newer null shadow', () => {
    const old = run('z', 1, {
      childTaskId: 'old',
      reviewNavKind: 'decided',
      clarifyNavKind: 'answered',
    })
    const fresh = run('a', 2, {
      childTaskId: 'new',
      reviewNavKind: 'awaiting',
      clarifyNavKind: 'awaiting',
    })
    expect(deriveCurrentCallNodeRun([old, fresh], 'n')?.id).toBe(fresh.id)
    expect(deriveCallNodeNav([fresh, old], 'n')).toEqual({ childTaskId: 'new' })
    expect(deriveReviewNodeNav([old, fresh], 'n')).toEqual({
      kind: 'awaiting',
      nodeRunId: fresh.id,
    })
    expect(deriveClarifyNodeNav([old, fresh], 'n')).toEqual({
      kind: 'awaiting',
      nodeRunId: fresh.id,
    })
    const shadow = run('0', 3)
    expect(deriveCallNodeNav([old, fresh, shadow], 'n')).toBeNull()
    expect(deriveReviewNodeNav([old, shadow, fresh], 'n')).toBeNull()
    expect(deriveClarifyNodeNav([old, fresh, shadow], 'n')).toBeNull()
  })
  test('history and frame groups retain mint order, not ID order', () => {
    const old = run('z', 1),
      fresh = run('a', 2),
      last = run('0', 3, { containerRunId: 'frame', scopePath: 'wrapper:0' })
    expect(nodeRunHistory(fresh, [fresh, old, last]).map((row) => row.id)).toEqual(['z', 'a', '0'])
    expect(
      groupHistoryByFrame(nodeRunHistory(fresh, [last, fresh, old])).flatMap((group) =>
        group.runs.map((row) => row.id),
      ),
    ).toEqual(['z', 'a', '0'])
    expect(clarifyRoundForRun(fresh, [fresh, old])).toBe(1)
  })
  test('host retry counts and first-attempt memory anchor follow generation boundaries', () => {
    const done = run('z', 1, { nodeId: '__wg_leader__' }),
      failed = run('b', 2, { nodeId: '__wg_leader__', status: 'failed' }),
      current = run('a', 3, { nodeId: '__wg_leader__', status: 'running' })
    expect(displayRetryForRun(current, [current, done, failed])).toBe(1)
    expect(findFirstAttemptSibling(current, [current, done, failed])?.id).toBe(failed.id)
    expect(findFirstAttemptSibling(run('new', null), [])).toBeUndefined()
  })
  test('room keeps the backend mint sequence while interleaving legacy messages', () => {
    const turn = (nodeRunId: string): WorkgroupRunEntry => ({
      nodeRunId,
      memberId: 'leader',
      displayName: null,
      kind: 'leader-round',
      status: 'running',
      round: 1,
      startedAt: null,
      finishedAt: null,
      triggerMessageId: null,
      assignmentId: null,
      note: null,
    })
    const turns = [turn('z'), turn('a')]
    expect(
      buildRoomTimeline([], turns)
        .filter((entry) => entry.type === 'turn')
        .map((entry) => entry.entry.nodeRunId),
    ).toEqual(['z', 'a'])
    expect(
      buildRoomTimeline([], turns, { dividers: false })
        .filter((entry) => entry.type === 'turn')
        .map((entry) => entry.entry.nodeRunId),
    ).toEqual(['z', 'a'])
  })
  test('wire payloads with an absent seq remain NULL-compatible', () => {
    const { seq: _seq, ...legacy } = run('legacy', null)
    expect(NodeRunSchema.parse(legacy).seq).toBeNull()
    expect(NodeRunSchema.parse({ ...legacy, seq: 2 }).seq).toBeGreaterThan(
      NodeRunSchema.parse({ ...legacy, seq: 1 }).seq!,
    )
    expect(NodeRunSchema.safeParse({ ...legacy, seq: 1.5 }).success).toBe(false)
  })
})
