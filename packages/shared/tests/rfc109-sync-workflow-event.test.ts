// RFC-109 — the `sync-workflow` task transition event added to the shared
// nextTaskStatus oracle (Codex design-gate F6: integrate with RFC-108's table
// rather than hand-copy an allowedFrom). Locks:
//   * sync-workflow targets `pending` and is legal from EVERY non-active status
//     (= resume ∪ retry) — the union the feature needs (failed/interrupted/
//     done/canceled/awaiting_review/awaiting_human);
//   * it is rejected from the active statuses (pending/running) because the
//     scheduler holds the snapshot there.
// The `never` exhaustiveness in nextTaskStatus/targetForTaskEvent already forces
// a compile error if a future status is added without handling sync-workflow.

import { describe, expect, test } from 'bun:test'
import { TASK_STATUS } from '../src/schemas/task'
import {
  IllegalTaskTransition,
  allowedFromForTaskEvent,
  nextTaskStatus,
  targetForTaskEvent,
} from '../src/lifecycle'

const NON_ACTIVE = [
  'awaiting_human',
  'awaiting_review',
  'canceled',
  'done',
  'failed',
  'interrupted',
].sort()

describe('RFC-109 sync-workflow transition event', () => {
  test('targets pending', () => {
    expect(targetForTaskEvent({ kind: 'sync-workflow' })).toBe('pending')
  })

  test('allowed from every non-active status (= resume ∪ retry)', () => {
    const allowed = [...allowedFromForTaskEvent({ kind: 'sync-workflow' })].sort()
    expect(allowed).toEqual(NON_ACTIVE)

    const resume = allowedFromForTaskEvent({ kind: 'resume' })
    const retry = allowedFromForTaskEvent({ kind: 'retry' })
    const union = [...new Set([...resume, ...retry])].sort()
    expect(allowed).toEqual(union)
  })

  test('rejected from the active statuses (scheduler holds the snapshot)', () => {
    for (const from of ['pending', 'running'] as const) {
      expect(() => nextTaskStatus(from, { kind: 'sync-workflow' })).toThrow(IllegalTaskTransition)
    }
  })

  test('property: legal pairs return pending, illegal pairs throw — consistent with allowedFrom', () => {
    const allowed = new Set(allowedFromForTaskEvent({ kind: 'sync-workflow' }))
    for (const from of TASK_STATUS) {
      if (allowed.has(from)) {
        expect(nextTaskStatus(from, { kind: 'sync-workflow' })).toBe('pending')
      } else {
        expect(() => nextTaskStatus(from, { kind: 'sync-workflow' })).toThrow(IllegalTaskTransition)
      }
    }
  })
})
