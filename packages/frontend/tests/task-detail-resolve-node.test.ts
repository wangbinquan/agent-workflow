// RFC-011 — tasks.detail.tsx exposes two tiny helpers to feed the
// NodeDetailDrawer Prompt tab. Worth a pure-function lock because the
// rest of the route is a 480-line component the JSDOM render path can
// only smoke-test.

import { describe, expect, test } from 'vitest'
import type { NodeRun } from '@agent-workflow/shared'
import { resolveNodeIdFromRuns, resolveNodeKindFromSnapshot } from '../src/routes/tasks.detail'
// 2026-07-02: moved to the shared lib so the task-question surfaces (board /
// pickers / answer pane) resolve node names through the same oracle.
import { agentNodeOptionsFromSnapshot, resolveNodeNameFromSnapshot } from '../src/lib/node-names'

function makeRun(id: string, nodeId: string): NodeRun {
  return {
    id,
    taskId: 't',
    nodeId,
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
  }
}

describe('RFC-011 resolveNodeIdFromRuns', () => {
  test('returns the node_run.nodeId for the matching id', () => {
    const r = makeRun('r1', 'agent_1')
    expect(resolveNodeIdFromRuns([r], 'r1')).toBe('agent_1')
  })

  test('returns null for unknown id', () => {
    expect(resolveNodeIdFromRuns([makeRun('r1', 'agent_1')], 'r2')).toBeNull()
  })

  test('returns null when nodeRunId is null', () => {
    expect(resolveNodeIdFromRuns([], null)).toBeNull()
  })
})

describe('RFC-011 resolveNodeKindFromSnapshot', () => {
  test('plucks kind from workflow snapshot nodes[]', () => {
    const snap = {
      nodes: [
        { id: 'n1', kind: 'agent-single' },
        { id: 'n2', kind: 'review' },
      ],
    }
    expect(resolveNodeKindFromSnapshot(snap, 'n1')).toBe('agent-single')
    expect(resolveNodeKindFromSnapshot(snap, 'n2')).toBe('review')
  })

  test('returns null when nodeId not in snapshot', () => {
    expect(
      resolveNodeKindFromSnapshot({ nodes: [{ id: 'n1', kind: 'input' }] }, 'mystery'),
    ).toBeNull()
  })

  test('returns null for malformed snapshot shapes', () => {
    expect(resolveNodeKindFromSnapshot(null, 'n1')).toBeNull()
    expect(resolveNodeKindFromSnapshot('not-object', 'n1')).toBeNull()
    expect(resolveNodeKindFromSnapshot({ nodes: 'oops' }, 'n1')).toBeNull()
  })
})

// Locks the priority order the node-runs table relies on: title > agentName /
// inputKey > null (caller falls back to nodeId). Mirrors canvas `nodeTitle`
// so the table label matches the canvas label for the same node.
describe('resolveNodeNameFromSnapshot', () => {
  const snap = {
    nodes: [
      { id: 'a1', kind: 'agent-single', agentName: 'auditor' },
      { id: 'a2', kind: 'agent-multi', agentName: 'fixer', title: 'Parallel fixer' },
      { id: 'in1', kind: 'input', inputKey: 'repo_path' },
      { id: 'c1', kind: 'clarify', title: 'Ask user' },
      { id: 'r1', kind: 'review' },
      { id: 'a3', kind: 'agent-single' },
    ],
  }

  test('explicit title wins over agentName', () => {
    expect(resolveNodeNameFromSnapshot(snap, 'a2')).toBe('Parallel fixer')
  })

  test('agent nodes fall back to agentName', () => {
    expect(resolveNodeNameFromSnapshot(snap, 'a1')).toBe('auditor')
  })

  test('input nodes fall back to inputKey', () => {
    expect(resolveNodeNameFromSnapshot(snap, 'in1')).toBe('repo_path')
  })

  test('clarify uses its title', () => {
    expect(resolveNodeNameFromSnapshot(snap, 'c1')).toBe('Ask user')
  })

  test('nodes with no displayable field return null', () => {
    expect(resolveNodeNameFromSnapshot(snap, 'r1')).toBeNull()
    expect(resolveNodeNameFromSnapshot(snap, 'a3')).toBeNull()
  })

  test('null nodeId / malformed snapshot return null', () => {
    expect(resolveNodeNameFromSnapshot(snap, null)).toBeNull()
    expect(resolveNodeNameFromSnapshot(null, 'a1')).toBeNull()
    expect(resolveNodeNameFromSnapshot({ nodes: 'oops' }, 'a1')).toBeNull()
  })
})

// 2026-07-02 (用户拍板「问题列表用节点名不用节点 ID」) — the board's nodeOptions labels
// resolve through resolveNodeNameFromSnapshot (title → agentName) with an id fallback,
// instead of the old `label: n.id`. Locks the wiring at the pure-function level.
describe('agentNodeOptionsFromSnapshot', () => {
  const snap = {
    nodes: [
      { id: 'a1', kind: 'agent-single', agentName: 'auditor' },
      { id: 'a2', kind: 'agent-single', agentName: 'fixer', title: '并行修复' },
      { id: 'a3', kind: 'agent-single' },
      { id: 'in1', kind: 'input', inputKey: 'repo_path' },
      { id: 'r1', kind: 'review', title: 'Gate' },
    ],
  }

  test('only agent nodes become options; labels prefer title, then agentName, then id', () => {
    expect(agentNodeOptionsFromSnapshot(snap)).toEqual([
      { id: 'a1', label: 'auditor' },
      { id: 'a2', label: '并行修复' },
      { id: 'a3', label: 'a3' },
    ])
  })

  test('malformed snapshot degrades to []', () => {
    expect(agentNodeOptionsFromSnapshot(null)).toEqual([])
    expect(agentNodeOptionsFromSnapshot('nope')).toEqual([])
    expect(agentNodeOptionsFromSnapshot({ nodes: 'oops' })).toEqual([])
  })
})
