// RFC-011 — pure helpers backing the Prompt-tab attempts switcher.
// These tests lock the ordering contract so the drawer always renders
// historical attempts left→right in chronological / shard-key order.

import { describe, expect, test } from 'vitest'
import type { NodeRun } from '@agent-workflow/shared'
import {
  formatAttemptLabel,
  isFanoutParentRun,
  sortNodeRunsForPromptHistory,
} from '../src/lib/node-prompt'

function makeRun(partial: Partial<NodeRun> & { id: string }): NodeRun {
  return {
    id: partial.id,
    taskId: 't1',
    nodeId: partial.nodeId ?? 'n1',
    parentNodeRunId: partial.parentNodeRunId ?? null,
    iteration: partial.iteration ?? 0,
    shardKey: partial.shardKey ?? null,
    retryIndex: partial.retryIndex ?? 0,
    reviewIteration: partial.reviewIteration ?? 0,
    status: partial.status ?? 'done',
    startedAt: partial.startedAt ?? null,
    finishedAt: partial.finishedAt ?? null,
    pid: partial.pid ?? null,
    exitCode: partial.exitCode ?? null,
    errorMessage: partial.errorMessage ?? null,
    supersededByReview: partial.supersededByReview ?? null,
    rolledBack: partial.rolledBack ?? null,
    promptText: partial.promptText ?? null,
    tokInput: partial.tokInput ?? null,
    tokOutput: partial.tokOutput ?? null,
    tokTotal: partial.tokTotal ?? null,
    tokCacheCreate: partial.tokCacheCreate ?? null,
    tokCacheRead: partial.tokCacheRead ?? null,
    opencodeSessionId: partial.opencodeSessionId ?? null,
  }
}

describe('RFC-011 sortNodeRunsForPromptHistory', () => {
  test('single attempt passes through unchanged', () => {
    const a = makeRun({ id: 'a' })
    expect(sortNodeRunsForPromptHistory([a]).map((r) => r.id)).toEqual(['a'])
  })

  test('orders by retryIndex ascending within the same iteration', () => {
    const r2 = makeRun({ id: 'r2', retryIndex: 2 })
    const r0 = makeRun({ id: 'r0', retryIndex: 0 })
    const r1 = makeRun({ id: 'r1', retryIndex: 1 })
    expect(sortNodeRunsForPromptHistory([r2, r0, r1]).map((r) => r.id)).toEqual(['r0', 'r1', 'r2'])
  })

  test('parent run sorts before its shard children', () => {
    const parent = makeRun({ id: 'p', parentNodeRunId: null, startedAt: 100 })
    const shardA = makeRun({ id: 'sa', parentNodeRunId: 'p', shardKey: 'a.ts', startedAt: 110 })
    const shardB = makeRun({ id: 'sb', parentNodeRunId: 'p', shardKey: 'b.ts', startedAt: 105 })
    const out = sortNodeRunsForPromptHistory([shardB, shardA, parent]).map((r) => r.id)
    expect(out).toEqual(['p', 'sa', 'sb'])
  })

  test('iteration takes precedence over retryIndex', () => {
    const a = makeRun({ id: 'a', iteration: 0, retryIndex: 5 })
    const b = makeRun({ id: 'b', iteration: 1, retryIndex: 0 })
    expect(sortNodeRunsForPromptHistory([b, a]).map((r) => r.id)).toEqual(['a', 'b'])
  })

  test('startedAt null sorts last among ties (pending row stays at the end)', () => {
    const done = makeRun({ id: 'd', startedAt: 1000 })
    const pending = makeRun({ id: 'p', startedAt: null })
    expect(sortNodeRunsForPromptHistory([pending, done]).map((r) => r.id)).toEqual(['d', 'p'])
  })
})

// RFC-146: isPromptCapableKind was replaced by shared `isAgentNodeKind`;
// its value/tolerance locks live in packages/backend/tests
// (node-kind-behavior-table.test.ts + inventory-service.test.ts).

describe('RFC-011 isFanoutParentRun', () => {
  test('a row with shard children → true', () => {
    const parent = makeRun({ id: 'p' })
    const child = makeRun({ id: 'c', parentNodeRunId: 'p', shardKey: 'a.ts' })
    expect(isFanoutParentRun(parent, [parent, child])).toBe(true)
  })

  test('a row without shard children → false', () => {
    const solo = makeRun({ id: 's' })
    expect(isFanoutParentRun(solo, [solo])).toBe(false)
  })

  test('a shard child itself is not a fan-out parent', () => {
    const parent = makeRun({ id: 'p' })
    const child = makeRun({ id: 'c', parentNodeRunId: 'p', shardKey: 'a.ts' })
    expect(isFanoutParentRun(child, [parent, child])).toBe(false)
  })
})

describe('RFC-011 formatAttemptLabel', () => {
  const t = (key: string, vars?: Record<string, string | number>): string =>
    vars === undefined ? key : `${key}|${JSON.stringify(vars)}`

  test('agent attempt uses promptAttemptEntry with iter/retry/status/time', () => {
    const run = makeRun({ id: 'a', iteration: 0, retryIndex: 2, status: 'done' })
    const label = formatAttemptLabel(run, { fanoutParent: false, t, timeString: '12:34' })
    expect(label).toContain('promptAttemptEntry')
    expect(label).toContain('"iter":0')
    expect(label).toContain('"retry":2')
    // Status is rendered through the noderun-status helper now so the
    // dropdown picks up the i18n label (e.g. "Done") instead of raw "done".
    expect(label).toContain('"status":"noderunStatus.done"')
    expect(label).toContain('"time":"12:34"')
  })

  test('shard attempt uses promptAttemptShard with shard key', () => {
    const run = makeRun({ id: 's', shardKey: 'src/foo.ts', status: 'failed' })
    const label = formatAttemptLabel(run, { fanoutParent: false, t, timeString: '13:00' })
    expect(label).toContain('promptAttemptShard')
    expect(label).toContain('"shard":"src/foo.ts"')
    expect(label).toContain('"status":"noderunStatus.failed"')
  })

  test('fan-out parent uses promptAttemptParent', () => {
    const run = makeRun({ id: 'p', status: 'done' })
    const label = formatAttemptLabel(run, { fanoutParent: true, t, timeString: '14:00' })
    expect(label).toContain('promptAttemptParent')
  })

  // The next two cases lock in the friendly status label for canceled
  // rows that the review iterate / reject path produced（RFC-145：字段驱动——
  // supersededByReview 非空且未回滚 = worktree 保留，标 "Superseded"；
  // rolledBack=true = 文件已重置，保持 "Canceled"，与 Stats tab chip 一致）。
  test('superseded canceled row renders noderunStatus.superseded label', () => {
    const run = makeRun({
      id: 'sup',
      status: 'canceled',
      supersededByReview: 'iterated',
      errorMessage:
        'superseded-by-review-iterated: Replaced by retry_index 1 due to review iterated of rev_1',
    })
    const label = formatAttemptLabel(run, { fanoutParent: false, t, timeString: '15:00' })
    expect(label).toContain('"status":"noderunStatus.superseded"')
  })

  test('rollback-canceled row keeps noderunStatus.canceled label', () => {
    const run = makeRun({
      id: 'rb',
      status: 'canceled',
      supersededByReview: 'rejected',
      rolledBack: true,
      errorMessage:
        'superseded-by-review-rejected-rollback: Replaced by retry_index 1 due to review rejected of rev_1',
    })
    const label = formatAttemptLabel(run, { fanoutParent: false, t, timeString: '15:00' })
    expect(label).toContain('"status":"noderunStatus.canceled"')
  })
})
