// RFC-046 — pure-function tests for the InjectedMemoriesCard helpers.

import { describe, expect, test } from 'vitest'
import type { InjectedMemorySnapshot, NodeRun } from '@agent-workflow/shared'
import {
  decideStatus,
  findFirstAttemptSibling,
  groupByScope,
  isFollowupInherit,
  previewOf,
  SCOPE_ORDER,
} from '@/lib/injected-memories-card'

function snap(overrides: Partial<InjectedMemorySnapshot> = {}): InjectedMemorySnapshot {
  return {
    id: 'm1',
    version: 1,
    scopeType: 'agent',
    scopeId: 'a',
    title: 't',
    bodyMd: 'b',
    tags: [],
    sourceKind: 'review',
    approvedAt: null,
    ...overrides,
  }
}

function run(overrides: Partial<NodeRun> = {}): NodeRun {
  return {
    id: 'r1',
    taskId: 't1',
    nodeId: 'n1',
    parentNodeRunId: null,
    iteration: 0,
    shardKey: null,
    retryIndex: 0,
    reviewIteration: 0,
    status: 'done',
    startedAt: 1,
    finishedAt: 2,
    pid: null,
    exitCode: 0,
    errorMessage: null,
    promptText: null,
    tokInput: null,
    tokOutput: null,
    tokTotal: null,
    tokCacheCreate: null,
    tokCacheRead: null,
    opencodeSessionId: null,
    ...overrides,
  } as NodeRun
}

// RFC-146: isAgentKind was replaced by shared `isAgentNodeKind`; its
// value/tolerance locks live in packages/backend/tests
// (node-kind-behavior-table.test.ts + inventory-service.test.ts).

describe('decideStatus', () => {
  test('null → pre-rfc046', () => {
    expect(decideStatus(null)).toBe('pre-rfc046')
  })
  test('undefined → pre-rfc046', () => {
    expect(decideStatus(undefined)).toBe('pre-rfc046')
  })
  test('empty array → empty', () => {
    expect(decideStatus([])).toBe('empty')
  })
  test('non-empty array → captured', () => {
    expect(decideStatus([snap()])).toBe('captured')
  })
})

describe('groupByScope', () => {
  test('partitions snapshots into the 4 fixed scopes', () => {
    const out = groupByScope([
      snap({ id: 'a1', scopeType: 'agent' }),
      snap({ id: 'w1', scopeType: 'workflow' }),
      snap({ id: 'a2', scopeType: 'agent' }),
      snap({ id: 'g1', scopeType: 'global', scopeId: null }),
    ])
    expect(out.agent.map((s) => s.id)).toEqual(['a1', 'a2'])
    expect(out.workflow.map((s) => s.id)).toEqual(['w1'])
    expect(out.repo).toEqual([])
    expect(out.global.map((s) => s.id)).toEqual(['g1'])
  })
  test('SCOPE_ORDER is agent → workflow → repo → global (locks the display order)', () => {
    expect(SCOPE_ORDER).toEqual(['agent', 'workflow', 'repo', 'global'])
  })
})

describe('previewOf', () => {
  test('preserves short body verbatim', () => {
    expect(previewOf('hello')).toBe('hello')
  })
  test('collapses whitespace + newlines to single spaces', () => {
    expect(previewOf('a\nb\n  c')).toBe('a b c')
  })
  test('truncates with ellipsis past the limit', () => {
    const long = 'x'.repeat(250)
    const out = previewOf(long, 200)
    expect(out.length).toBe(201)
    expect(out.endsWith('…')).toBe(true)
  })
  test('default limit is 200', () => {
    expect(previewOf('x'.repeat(199)).length).toBe(199)
    expect(previewOf('x'.repeat(201)).length).toBe(201)
  })
})

describe('findFirstAttemptSibling', () => {
  const runs = [
    // RFC-074 PR-C: r0 is attempt-0 that FAILED (the only state under which its
    // retry r1 exists) — the generation anchor walks by id and treats a `failed`
    // predecessor as same-generation, so r1 anchors back to r0.
    run({ id: 'r0', nodeId: 'n', retryIndex: 0, iteration: 0, status: 'failed' }),
    run({ id: 'r1', nodeId: 'n', retryIndex: 1, iteration: 0 }),
    run({ id: 'r0-iter1', nodeId: 'n', retryIndex: 0, iteration: 1 }),
    run({ id: 'shard-a', nodeId: 'n', retryIndex: 0, shardKey: 'a' }),
  ]
  test('a retry anchors back to its generation start (failed attempt-0)', () => {
    expect(findFirstAttemptSibling(runs[1]!, runs)?.id).toBe('r0')
  })
  test('cross-clarify designer rerun (retry=max+1) anchors to itself, not the prior gen', () => {
    // Regression: the retired retry=0 anchor returned the prior generation's
    // retry=0 row for a designer rerun; the boundary walk anchors a generation
    // start (predecessor `done`) to itself. The designer rerun is the start of
    // its own generation, so it must anchor to itself (→ isFollowupInherit false).
    const gen = [
      run({ id: 'd0', nodeId: 'd', retryIndex: 0, iteration: 0, status: 'done' }),
      run({ id: 'd1-rerun', nodeId: 'd', retryIndex: 5, iteration: 0, status: 'done' }),
    ]
    expect(findFirstAttemptSibling(gen[1]!, gen)?.id).toBe('d1-rerun')
  })
  test('discriminates by iteration', () => {
    expect(
      findFirstAttemptSibling(run({ retryIndex: 1, iteration: 1, nodeId: 'n' }), runs)?.id,
    ).toBe('r0-iter1')
  })
  test('discriminates by shardKey', () => {
    // RFC-074 PR-C: anchor = retry=0 row with the largest id ≤ the query run's
    // id, so the retry=1 query row carries a causal id larger than 'shard-a'.
    expect(
      findFirstAttemptSibling(
        run({ id: 'shard-a-r1', retryIndex: 1, shardKey: 'a', nodeId: 'n' }),
        runs,
      )?.id,
    ).toBe('shard-a')
  })
  test('returns undefined when no sibling exists', () => {
    expect(findFirstAttemptSibling(run({ retryIndex: 5, nodeId: 'unknown' }), runs)).toBeUndefined()
  })
})

describe('isFollowupInherit', () => {
  test('retryIndex=0 → false (this run IS attempt 0)', () => {
    expect(isFollowupInherit(run({ retryIndex: 0 }), undefined)).toBe(false)
  })
  test('no attempt0 → false', () => {
    expect(isFollowupInherit(run({ retryIndex: 1, opencodeSessionId: 's' }), undefined)).toBe(false)
  })
  test('same session id as attempt 0 → true', () => {
    const a0 = run({ id: 'r0', retryIndex: 0, opencodeSessionId: 's' })
    const a1 = run({ id: 'r1', retryIndex: 1, opencodeSessionId: 's' })
    expect(isFollowupInherit(a1, a0)).toBe(true)
  })
  test('different session id → false (means scheduler started a fresh session)', () => {
    const a0 = run({ id: 'r0', retryIndex: 0, opencodeSessionId: 's0' })
    const a1 = run({ id: 'r1', retryIndex: 1, opencodeSessionId: 's1' })
    expect(isFollowupInherit(a1, a0)).toBe(false)
  })
  test('null session id → false (legacy or pre-spawn failure)', () => {
    const a0 = run({ id: 'r0', retryIndex: 0, opencodeSessionId: null })
    const a1 = run({ id: 'r1', retryIndex: 1, opencodeSessionId: null })
    expect(isFollowupInherit(a1, a0)).toBe(false)
  })
})
