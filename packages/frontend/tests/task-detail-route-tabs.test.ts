// RFC-198 §6.2 regression matrix for the task detail's URL-backed tabs.
//
// The room aggregate arrives after the task row. These pure tests lock that
// late config/error/phase transitions never temporarily classify a workgroup as
// the wrong shape or let the URL and rendered panel diverge.

import { describe, expect, test } from 'vitest'
import {
  isTaskDetailTab,
  resolveTaskDetailTabs,
  validateTaskDetailSearch,
  withTaskDetailTab,
} from '../src/lib/task-detail-route-tabs'

const pendingRoom = { status: 'pending' } as const
const roomError = { status: 'error' } as const
const turnEngineRoom = { status: 'ready', mode: 'turn-engine' } as const

describe('task-detail search syntax', () => {
  test('accepts every TaskDetailTab wire key and rejects display aliases', () => {
    const wireKeys = [
      'workflow-status',
      'node-runs',
      'details',
      'outputs',
      'worktree-files',
      'worktree-diff',
      'worktree-structure',
      'feedback',
      'task-questions',
      'chatroom',
      'dw-orchestration',
    ]
    for (const tab of wireKeys) expect(isTaskDetailTab(tab)).toBe(true)
    for (const alias of ['overview', 'runs', 'questions', 'runtime', '', 1, null]) {
      expect(isTaskDetailTab(alias)).toBe(false)
    }
  })

  test('validator removes only an invalid tab and preserves unrelated search payload', () => {
    expect(validateTaskDetailSearch({ tab: 'overview', focus: 'node-1', trace: 2 })).toEqual({
      focus: 'node-1',
      trace: 2,
    })
    expect(validateTaskDetailSearch({ tab: 'details', focus: 'node-1' })).toEqual({
      tab: 'details',
      focus: 'node-1',
    })
  })

  test('functional tab updater changes only tab', () => {
    expect(withTaskDetailTab({ tab: 'details', focus: 'node-1', trace: 2 }, 'node-runs')).toEqual({
      tab: 'node-runs',
      focus: 'node-1',
      trace: 2,
    })
  })
})

describe('resolveTaskDetailTabs — plain tasks', () => {
  test('waits for the task row instead of canonicalizing an unloaded task', () => {
    expect(
      resolveTaskDetailTabs({
        taskLoaded: false,
        hasOutputs: false,
        isWorkgroup: false,
        room: pendingRoom,
      }),
    ).toEqual({ status: 'pending' })
  })

  test('missing search canonicalizes to workflow-status with replace intent', () => {
    const result = resolveTaskDetailTabs({
      taskLoaded: true,
      hasOutputs: true,
      isWorkgroup: false,
      room: pendingRoom,
    })
    expect(result).toMatchObject({
      status: 'ready',
      shape: 'plain',
      tab: 'workflow-status',
      canonicalize: true,
    })
  })

  test('available explicit deep link wins and needs no canonical replace', () => {
    const result = resolveTaskDetailTabs({
      taskLoaded: true,
      hasOutputs: true,
      isWorkgroup: false,
      room: pendingRoom,
      searchTab: 'worktree-diff',
    })
    expect(result).toMatchObject({ tab: 'worktree-diff', canonicalize: false })
  })

  test('outputs deep link falls back when the frozen snapshot declares no outputs', () => {
    const result = resolveTaskDetailTabs({
      taskLoaded: true,
      hasOutputs: false,
      isWorkgroup: false,
      room: pendingRoom,
      searchTab: 'outputs',
    })
    expect(result).toMatchObject({ tab: 'workflow-status', canonicalize: true })
    if (result.status === 'ready') expect(result.tabs).not.toContain('outputs')
  })
})

describe('resolveTaskDetailTabs — async workgroup classification', () => {
  test('late room config remains pending rather than flashing turn-engine/chatroom', () => {
    expect(
      resolveTaskDetailTabs({
        taskLoaded: true,
        hasOutputs: true,
        isWorkgroup: true,
        room: pendingRoom,
        searchTab: 'workflow-status',
      }),
    ).toEqual({ status: 'pending' })
  })

  test('turn-engine defaults to chatroom and rejects a cross-shape canvas deep link', () => {
    expect(
      resolveTaskDetailTabs({
        taskLoaded: true,
        hasOutputs: true,
        isWorkgroup: true,
        room: turnEngineRoom,
        searchTab: 'workflow-status',
      }),
    ).toMatchObject({
      status: 'ready',
      shape: 'turn-engine',
      tab: 'chatroom',
      canonicalize: true,
    })
  })

  test('turn-engine honors an available details deep link', () => {
    expect(
      resolveTaskDetailTabs({
        taskLoaded: true,
        hasOutputs: false,
        isWorkgroup: true,
        room: turnEngineRoom,
        searchTab: 'details',
      }),
    ).toMatchObject({ tab: 'details', canonicalize: false })
  })

  test('dynamic default follows the first stable phase', () => {
    const beforeConfirm = resolveTaskDetailTabs({
      taskLoaded: true,
      hasOutputs: true,
      isWorkgroup: true,
      room: { status: 'ready', mode: 'dynamic-workflow', dwPhase: 'awaiting_confirm' },
    })
    const executing = resolveTaskDetailTabs({
      taskLoaded: true,
      hasOutputs: true,
      isWorkgroup: true,
      room: { status: 'ready', mode: 'dynamic-workflow', dwPhase: 'executing' },
    })
    expect(beforeConfirm).toMatchObject({
      shape: 'dynamic-workflow',
      tab: 'dw-orchestration',
      canonicalize: true,
    })
    expect(executing).toMatchObject({
      shape: 'dynamic-workflow',
      tab: 'workflow-status',
      canonicalize: true,
    })
  })

  test('a canonical/manual dynamic URL wins after phase changes', () => {
    const afterPhaseChange = resolveTaskDetailTabs({
      taskLoaded: true,
      hasOutputs: true,
      isWorkgroup: true,
      room: { status: 'ready', mode: 'dynamic-workflow', dwPhase: 'executing' },
      searchTab: 'dw-orchestration',
    })
    expect(afterPhaseChange).toMatchObject({
      tab: 'dw-orchestration',
      canonicalize: false,
    })
  })

  test('dynamic outputs fallback uses the phase default when outputs disappear', () => {
    expect(
      resolveTaskDetailTabs({
        taskLoaded: true,
        hasOutputs: false,
        isWorkgroup: true,
        room: { status: 'ready', mode: 'dynamic-workflow', dwPhase: 'executing' },
        searchTab: 'outputs',
      }),
    ).toMatchObject({ tab: 'workflow-status', canonicalize: true })
  })

  test('terminal room error preserves raw valid search and exposes details safely', () => {
    expect(
      resolveTaskDetailTabs({
        taskLoaded: true,
        hasOutputs: true,
        isWorkgroup: true,
        room: roomError,
        searchTab: 'chatroom',
      }),
    ).toEqual({ status: 'error', requestedTab: 'chatroom' })
    expect(
      resolveTaskDetailTabs({
        taskLoaded: true,
        hasOutputs: true,
        isWorkgroup: true,
        room: roomError,
        searchTab: 'details',
      }),
    ).toEqual({ status: 'error', requestedTab: 'details' })
  })

  test('retry success resolves from the same preserved search without an intermediate rewrite', () => {
    const failed = resolveTaskDetailTabs({
      taskLoaded: true,
      hasOutputs: true,
      isWorkgroup: true,
      room: roomError,
      searchTab: 'dw-orchestration',
    })
    const retried = resolveTaskDetailTabs({
      taskLoaded: true,
      hasOutputs: true,
      isWorkgroup: true,
      room: { status: 'ready', mode: 'dynamic-workflow', dwPhase: 'awaiting_confirm' },
      searchTab: 'dw-orchestration',
    })
    expect(failed.status).toBe('error')
    expect(retried).toMatchObject({ tab: 'dw-orchestration', canonicalize: false })
  })
})
