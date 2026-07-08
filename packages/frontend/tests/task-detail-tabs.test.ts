// RFC-021: pure-function coverage for the task detail page's tab logic.
//
// Why: keeps the route component testable as pure JSX wiring; every
// branch of "which tab does the failed-node jump select?" and "is the
// outputs tab visible?" lives in a tested helper instead of a
// hand-rolled inline calculation.

import { describe, expect, test } from 'vitest'
import type { NodeRun } from '@agent-workflow/shared'
import { TAB_ORDER, availableTabs, nextTabForFailedJump } from '../src/lib/task-detail-tabs'

function makeRun(over: Partial<NodeRun>): NodeRun {
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
    startedAt: null,
    finishedAt: null,
    pid: null,
    exitCode: null,
    errorMessage: null,
    supersededByReview: null,
    rolledBack: null,
    promptText: null,
    tokInput: null,
    tokOutput: null,
    tokTotal: null,
    tokCacheCreate: null,
    tokCacheRead: null,
    opencodeSessionId: null,
    ...over,
  } satisfies NodeRun
}

describe('TAB_ORDER', () => {
  test('is the canonical 8-tab order from the RFC (RFC-083 inserted worktree-structure)', () => {
    // RFC-065 added `worktree-files` between `outputs` and `worktree-diff`.
    // RFC-083 added `worktree-structure` immediately after `worktree-diff`.
    // `feedback` remains last as the RFC-041 reflective tab.
    expect(TAB_ORDER).toEqual([
      'workflow-status',
      'task-questions',
      'node-runs',
      'details',
      'outputs',
      'worktree-files',
      'worktree-diff',
      'worktree-structure',
      'feedback',
    ])
  })

  test('is readonly (frozen at the type level — defense against accidental sort)', () => {
    expect(TAB_ORDER).toHaveLength(9)
  })

  test('worktree-structure sits immediately after worktree-diff', () => {
    const outIdx = TAB_ORDER.indexOf('outputs')
    const filesIdx = TAB_ORDER.indexOf('worktree-files')
    const diffIdx = TAB_ORDER.indexOf('worktree-diff')
    const structIdx = TAB_ORDER.indexOf('worktree-structure')
    expect(filesIdx).toBe(outIdx + 1)
    expect(diffIdx).toBe(filesIdx + 1)
    expect(structIdx).toBe(diffIdx + 1)
  })
})

describe('availableTabs', () => {
  test('returns all 8 tabs when the workflow declares outputs', () => {
    expect(availableTabs({ hasOutputs: true })).toEqual([
      'workflow-status',
      'task-questions',
      'node-runs',
      'details',
      'outputs',
      'worktree-files',
      'worktree-diff',
      'worktree-structure',
      'feedback',
    ])
  })

  test('hides only the outputs tab when no output nodes exist; worktree-files + feedback always present', () => {
    const tabs = availableTabs({ hasOutputs: false })
    expect(tabs).toEqual([
      'workflow-status',
      'task-questions',
      'node-runs',
      'details',
      'worktree-files',
      'worktree-diff',
      'worktree-structure',
      'feedback',
    ])
    expect(tabs.includes('outputs' as never)).toBe(false)
    // worktree-files is unconditional — a task's worktree is always worth
    // browsing, even when no output ports are declared.
    expect(tabs).toContain('worktree-files')
    expect(tabs).toContain('feedback')
  })
})

describe('nextTabForFailedJump', () => {
  test('null failedNodeId → null runId, workflow-status tab', () => {
    expect(nextTabForFailedJump([], null)).toEqual({
      runId: null,
      tab: 'workflow-status',
    })
  })

  test('picks the most-recently-started run for the failed node', () => {
    const runs: NodeRun[] = [
      makeRun({ id: 'r1', nodeId: 'agent_x', startedAt: 1000 }),
      makeRun({ id: 'r2', nodeId: 'agent_x', startedAt: 3000 }),
      makeRun({ id: 'r3', nodeId: 'agent_x', startedAt: 2000 }),
      makeRun({ id: 'r4', nodeId: 'agent_y', startedAt: 5000 }), // different node
    ]
    expect(nextTabForFailedJump(runs, 'agent_x')).toEqual({
      runId: 'r2',
      tab: 'workflow-status',
    })
  })

  test('no matching run → null runId but still switches to canvas', () => {
    const runs: NodeRun[] = [makeRun({ id: 'r1', nodeId: 'agent_other', startedAt: 1000 })]
    expect(nextTabForFailedJump(runs, 'agent_missing')).toEqual({
      runId: null,
      tab: 'workflow-status',
    })
  })

  test('treats null startedAt as 0 so a pending run never beats a started one', () => {
    const runs: NodeRun[] = [
      makeRun({ id: 'r_pending', nodeId: 'n', startedAt: null }),
      makeRun({ id: 'r_started', nodeId: 'n', startedAt: 10 }),
    ]
    expect(nextTabForFailedJump(runs, 'n').runId).toBe('r_started')
  })
})
