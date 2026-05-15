// RFC-011 — tasks.detail.tsx exposes two tiny helpers to feed the
// NodeDetailDrawer Prompt tab. Worth a pure-function lock because the
// rest of the route is a 480-line component the JSDOM render path can
// only smoke-test.

import { describe, expect, test } from 'vitest'
import type { NodeRun } from '@agent-workflow/shared'
import { resolveNodeIdFromRuns, resolveNodeKindFromSnapshot } from '../src/routes/tasks.detail'

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
    promptText: null,
    tokInput: null,
    tokOutput: null,
    tokTotal: null,
    tokCacheCreate: null,
    tokCacheRead: null,
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
