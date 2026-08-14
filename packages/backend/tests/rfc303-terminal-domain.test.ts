// RFC-303 domain locks: stable provider-neutral stream identity, exact-body
// fact dedupe, absorbing merged state, and monotonic task fences.
import { describe, expect, test } from 'bun:test'

import type { CodeHostEvent } from '@agent-workflow/shared'

import {
  decideProtectedLaunch,
  linearizeMrEvent,
  mrFactKey,
  sourceTerminationBinding,
  stableMrIdentityOf,
} from '@/modules/integration/domain/mrTerminalControl'
import {
  applySourceTerminationFence,
  clearClosedSourceTerminationFence,
  inheritSourceTerminationSnapshot,
  sourceTerminationRevivalError,
  sourceTerminationTargetDisposition,
  taskStopProjection,
  type SourceTerminationSnapshot,
} from '@/modules/task-execution/domain/sourceTermination'

function event(overrides: Partial<CodeHostEvent> = {}): CodeHostEvent {
  return {
    provider: 'gitlab',
    eventUuid: 'event-1',
    eventType: 'mr_opened',
    repoPath: 'old/path',
    repoHttpUrl: 'https://example.test/old/path.git',
    repoSshUrl: 'git@example.test:old/path.git',
    projectId: '9001',
    mrIid: '42',
    author: {},
    raw: {},
    ...overrides,
  }
}

describe('RFC-303 integration domain', () => {
  test('identity is stable across repo rename and adjacent dimensions do not collide', () => {
    const before = stableMrIdentityOf(event())
    const renamed = stableMrIdentityOf(event({ repoPath: 'new/path' }))
    expect(before).toEqual(renamed)
    expect(before?.streamKey).toBe('["mr-stream-v1","9001","42"]')

    const binding = sourceTerminationBinding({ endpointId: 'e1', projectId: '9001', mrIid: '42' })
    expect(binding).toStartWith('st1:')
    expect(binding).not.toBe(
      sourceTerminationBinding({ endpointId: 'e2', projectId: '9001', mrIid: '42' }),
    )
    expect(binding).not.toBe(
      sourceTerminationBinding({ endpointId: 'e1', projectId: '9002', mrIid: '42' }),
    )
    expect(binding).not.toBe(
      sourceTerminationBinding({ endpointId: 'e1', projectId: '9001', mrIid: '43' }),
    )
  })

  test('MR-family missing identity fails closed while branch pipeline remains unprotected', () => {
    expect(
      decideProtectedLaunch({
        cancelOnMrTerminal: true,
        endpointId: 'e1',
        event: event({ projectId: undefined }),
        streamState: null,
      }),
    ).toEqual({ kind: 'invalid-mr-identity' })

    expect(
      decideProtectedLaunch({
        cancelOnMrTerminal: true,
        endpointId: 'e1',
        event: event({ eventType: 'pipeline_failed', mrIid: undefined }),
        streamState: null,
      }),
    ).toEqual({ kind: 'unprotected' })
  })

  test('protected launch binds the current revision and closed/merged block future launch', () => {
    const open = { state: 'open' as const, revision: 7, lastTerminalRevision: null }
    const protectedDecision = decideProtectedLaunch({
      cancelOnMrTerminal: true,
      endpointId: 'e1',
      event: event({ eventType: 'note' }),
      streamState: open,
    })
    expect(protectedDecision.kind).toBe('protected')
    if (protectedDecision.kind === 'protected') expect(protectedDecision.launchRevision).toBe(7)

    for (const state of ['closed', 'merged'] as const) {
      expect(
        decideProtectedLaunch({
          cancelOnMrTerminal: true,
          endpointId: 'e1',
          event: event(),
          streamState: { state, revision: 8, lastTerminalRevision: 8 },
        }),
      ).toEqual(expect.objectContaining({ kind: 'blocked', state }))
    }
  })

  test('fact key prefers provider UUID and otherwise hashes exact raw bytes plus type/provider', () => {
    expect(
      mrFactKey({
        provider: 'gitlab',
        eventUuid: 'abc',
        normalizedEventType: 'mr_closed',
        rawBodyBytes: new TextEncoder().encode('{}'),
      }),
    ).toBe('id:gitlab:abc')

    const base = {
      provider: 'github' as const,
      eventUuid: null,
      normalizedEventType: 'mr_closed' as const,
      rawBodyBytes: new TextEncoder().encode('{"a":1}'),
    }
    const key = mrFactKey(base)
    expect(key).toStartWith('body:v1:')
    expect(mrFactKey(base)).toBe(key)
    expect(mrFactKey({ ...base, rawBodyBytes: new TextEncoder().encode('{"a":1 }') })).not.toBe(key)
    expect(mrFactKey({ ...base, normalizedEventType: 'mr_merged' })).not.toBe(key)
  })

  test('closed can reopen, merged is absorbing, and revisions must be contiguous', () => {
    const closed = linearizeMrEvent(null, 'mr_closed', 1)
    expect(closed).toEqual({
      state: { state: 'closed', revision: 1, lastTerminalRevision: 1 },
      effectKind: 'fence-closed',
    })
    const reopened = linearizeMrEvent(closed.state, 'mr_opened', 2)
    expect(reopened.state.state).toBe('open')
    expect(reopened.effectKind).toBe('clear-closed')
    const merged = linearizeMrEvent(reopened.state, 'mr_merged', 3)
    expect(merged.state.state).toBe('merged')
    expect(linearizeMrEvent(merged.state, 'mr_opened', 4).state.state).toBe('merged')
    expect(linearizeMrEvent(merged.state, 'mr_closed', 4).state.state).toBe('merged')
    expect(() => linearizeMrEvent(merged.state, 'mr_updated', 5)).toThrow(
      'mr-stream-revision-invalid',
    )
  })
})

describe('RFC-303 task-execution domain', () => {
  const snapshot: SourceTerminationSnapshot = {
    binding: 'st1:x',
    launchRevision: 2,
    fence: null,
    effectRevision: null,
  }

  test('target cutoff is strict, merged is monotonic, and reopen clears only closed', () => {
    expect(applySourceTerminationFence(snapshot, 'closed', 2)).toBe(snapshot)
    const closed = applySourceTerminationFence(snapshot, 'closed', 3)
    expect(closed).toEqual({ ...snapshot, fence: 'closed', effectRevision: 3 })
    const merged = applySourceTerminationFence(closed, 'merged', 4)
    expect(merged.fence).toBe('merged')
    expect(clearClosedSourceTerminationFence(merged, 5).fence).toBe('merged')
    expect(clearClosedSourceTerminationFence(closed, 4).fence).toBeNull()
  })

  test('children inherit an immutable value snapshot and revival errors are stable', () => {
    const inherited = inheritSourceTerminationSnapshot(snapshot)
    expect(inherited).toEqual(snapshot)
    expect(inherited).not.toBe(snapshot)
    expect(sourceTerminationRevivalError('closed')).toBe('task-source-terminal-closed')
    expect(sourceTerminationRevivalError('merged')).toBe('task-source-terminal-merged')
    expect(sourceTerminationRevivalError(null)).toBeNull()
  })

  test('four live/waiting states cancel and existing terminal states remain truthful', () => {
    for (const status of ['pending', 'running', 'awaiting_review', 'awaiting_human'] as const) {
      expect(sourceTerminationTargetDisposition(status)).toBe('cancel')
    }
    for (const status of ['done', 'failed', 'canceled', 'interrupted'] as const) {
      expect(sourceTerminationTargetDisposition(status)).toBe('already-terminal')
    }
  })

  test('terminal causes project to exact root codes; cascade keeps its own provenance', () => {
    expect(
      taskStopProjection({
        kind: 'webhook-terminal',
        terminal: 'closed',
        deliveryId: 'd1',
        streamRevision: 3,
      }).code,
    ).toBe('webhook-mr-closed')
    expect(
      taskStopProjection({
        kind: 'webhook-terminal',
        terminal: 'merged',
        deliveryId: 'd2',
        streamRevision: 4,
      }).code,
    ).toBe('webhook-mr-merged')
    expect(
      taskStopProjection({
        kind: 'parent-cascade',
        parentTaskId: 'p1',
        rootCause: { terminal: 'merged', deliveryId: 'd2', streamRevision: 4 },
      }).code,
    ).toBe('canceled-by-parent-cascade')
  })
})
