// RFC-021: pure-function coverage for the task detail page's tab logic.
//
// Why: keeps the route component testable as pure JSX wiring; every
// branch of "which tab does the failed-node jump select?" and "is the
// outputs tab visible?" lives in a tested helper instead of a
// hand-rolled inline calculation.

import { describe, expect, test } from 'vitest'
import type { NodeRun, Task } from '@agent-workflow/shared'
import {
  DYNAMIC_WORKGROUP_TAB_ORDER,
  TAB_ORDER,
  WORKGROUP_TAB_ORDER,
  availableTabs,
  canOfferFailedJump,
  defaultDynamicTab,
  deriveTaskDetailCapabilities,
  deriveTaskDetailNavigation,
  nextTabForFailedJump,
} from '../src/lib/task-detail-tabs'

function makeRun(over: Partial<NodeRun>): NodeRun {
  return {
    id: 'r1',
    taskId: 't1',
    nodeId: 'n1',
    parentNodeRunId: null,
    iteration: 0,
    shardKey: null,
    retryIndex: 0,
    wgRound: null,
    rerunCause: null,
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

function makeCapabilityTask(overrides: Partial<Task> = {}): Task {
  return {
    workgroupId: null,
    repoCount: 1,
    repos: [],
    worktreePath: '/worktree/task',
    baseCommit: 'abc123',
    ...overrides,
  } as Task
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

  // RFC-167 PR-3 — dynamic_workflow tasks: full workflow-tab family + the
  // orchestration panel first; no chatroom (dynamic mode has no turns).
  test('isDynamicWorkgroup wins over isWorkgroup and keeps the outputs filter', () => {
    const tabs = availableTabs({ hasOutputs: true, isWorkgroup: true, isDynamicWorkgroup: true })
    expect(tabs).toEqual([...DYNAMIC_WORKGROUP_TAB_ORDER])
    expect(tabs[0]).toBe('dw-orchestration')
    expect(tabs).not.toContain('chatroom')
    const noOutputs = availableTabs({
      hasOutputs: false,
      isWorkgroup: true,
      isDynamicWorkgroup: true,
    })
    expect(noOutputs).not.toContain('outputs')
    expect(noOutputs).toContain('workflow-status')
  })

  test('turn-engine workgroup set is untouched by the dynamic flag default', () => {
    expect(availableTabs({ hasOutputs: true, isWorkgroup: true })).toEqual([
      'chatroom',
      'task-questions',
      'worktree-structure',
      'details',
    ])
  })
})

describe('RFC-201 task detail capabilities and page-section groups', () => {
  const plainRelated = {
    hasOutputs: true,
    room: { status: 'ready', mode: 'turn-engine' } as const,
    canReadQuestions: true,
    canReadFeedback: false,
  }

  test('filters unavailable outputs/worktree/feedback instead of exposing dead sections', () => {
    const capabilities = deriveTaskDetailCapabilities(
      makeCapabilityTask({ worktreePath: '', baseCommit: null }),
      { ...plainRelated, hasOutputs: false },
    )
    expect(capabilities).toMatchObject({
      outputs: false,
      worktreeFiles: false,
      worktreeDiff: false,
      worktreeStructure: false,
      questions: true,
      feedback: false,
    })
    expect(availableTabs({ hasOutputs: false, capabilities })).toEqual([
      'workflow-status',
      'task-questions',
      'node-runs',
      'details',
    ])
  })

  test('multi-repo repos[] keep diff and structure available when top-level baseCommit is null', () => {
    const capabilities = deriveTaskDetailCapabilities(
      makeCapabilityTask({
        repoCount: 2,
        worktreePath: '/worktree/task-parent',
        baseCommit: null,
        repos: [
          {
            repoIndex: 0,
            repoPath: '/repo/a',
            repoUrl: null,
            baseBranch: 'main',
            branch: 'task/a',
            workingBranch: null,
            baseCommit: null,
            worktreePath: '/worktree/task-parent/a',
            worktreeDirName: 'a',
            hasSubmodules: null,
            submoduleInitOk: null,
            submoduleInitError: null,
          },
          {
            repoIndex: 1,
            repoPath: '/repo/b',
            repoUrl: null,
            baseBranch: 'main',
            branch: 'task/b',
            workingBranch: null,
            baseCommit: 'def456',
            worktreePath: '/worktree/task-parent/b',
            worktreeDirName: 'b',
            hasSubmodules: null,
            submoduleInitOk: null,
            submoduleInitError: null,
          },
        ],
      }),
      plainRelated,
    )
    expect(capabilities.worktreeFiles).toBe(true)
    expect(capabilities.worktreeDiff).toBe(true)
    expect(capabilities.worktreeStructure).toBe(true)
  })

  test('room shape exposes exactly orchestration or chatroom after stable classification', () => {
    const turn = deriveTaskDetailCapabilities(makeCapabilityTask({ workgroupId: 'wg' }), {
      ...plainRelated,
      room: { status: 'ready', mode: 'turn-engine' },
    })
    const dynamic = deriveTaskDetailCapabilities(makeCapabilityTask({ workgroupId: 'wg' }), {
      ...plainRelated,
      room: { status: 'ready', mode: 'dynamic-workflow' },
    })
    const pending = deriveTaskDetailCapabilities(makeCapabilityTask({ workgroupId: 'wg' }), {
      ...plainRelated,
      room: { status: 'pending' },
    })
    expect(turn).toMatchObject({ chatroom: true, orchestration: false })
    expect(dynamic).toMatchObject({ chatroom: false, orchestration: true })
    expect(pending).toMatchObject({ chatroom: false, orchestration: false })
  })

  test('groups every existing wire key without inventing display aliases', () => {
    const navigation = deriveTaskDetailNavigation([...DYNAMIC_WORKGROUP_TAB_ORDER])
    expect(navigation.availableTabs).toEqual([...DYNAMIC_WORKGROUP_TAB_ORDER])
    expect(navigation.groups).toEqual([
      {
        key: 'overview',
        items: ['workflow-status', 'details', 'dw-orchestration'],
      },
      { key: 'execution', items: ['node-runs'] },
      {
        key: 'artifacts',
        items: ['outputs', 'worktree-files', 'worktree-diff', 'worktree-structure'],
      },
      { key: 'collaboration', items: ['task-questions', 'feedback'] },
    ])
    expect(navigation.defaultForGroup).toEqual({
      overview: 'workflow-status',
      execution: 'node-runs',
      artifacts: 'outputs',
      collaboration: 'task-questions',
    })
  })
})

describe('defaultDynamicTab — phase-driven default (RFC-167)', () => {
  test('pre-confirm phases land on the orchestration panel; executing lands on the canvas', () => {
    expect(defaultDynamicTab('generating')).toBe('dw-orchestration')
    expect(defaultDynamicTab('awaiting_confirm')).toBe('dw-orchestration')
    expect(defaultDynamicTab('rejected')).toBe('dw-orchestration')
    expect(defaultDynamicTab('executing')).toBe('workflow-status')
    expect(defaultDynamicTab(null)).toBe('dw-orchestration')
    expect(defaultDynamicTab(undefined)).toBe('dw-orchestration')
  })
})

// Scheduling-architecture review 2026-07-14: the failed-banner jump button
// hardcodes tab 'workflow-status' (nextTabForFailedJump), but the turn-engine
// workgroup tab set has no such tab — clicking bounced straight back to
// 'chatroom' via the invalid-tab fallback effect, with a dangling node-run
// selection nothing consumes. canOfferFailedJump is the pure gate the button
// render must consult; these cases lock which tab sets offer the jump.
describe('canOfferFailedJump', () => {
  test('plain workflow set offers the jump (with or without outputs)', () => {
    expect(canOfferFailedJump(availableTabs({ hasOutputs: true }))).toBe(true)
    expect(canOfferFailedJump(availableTabs({ hasOutputs: false }))).toBe(true)
  })

  test('turn-engine workgroup set has no canvas → jump suppressed', () => {
    expect(canOfferFailedJump(availableTabs({ hasOutputs: true, isWorkgroup: true }))).toBe(false)
    expect(canOfferFailedJump([...WORKGROUP_TAB_ORDER])).toBe(false)
  })

  test('dynamic-workgroup set keeps the real DAG canvas → jump stays offered', () => {
    expect(
      canOfferFailedJump(
        availableTabs({ hasOutputs: false, isWorkgroup: true, isDynamicWorkgroup: true }),
      ),
    ).toBe(true)
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
