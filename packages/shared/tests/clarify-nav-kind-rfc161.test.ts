// RFC-161 — the shared clarify-nav mapping the backend (getTaskNodeRuns →
// clarifyNavKind) and the task-detail canvas both key off. Locking this keeps
// "the canvas marks a clarify node clickable" tied to a single round-status
// projection, mirroring RFC-158's clarifyNavKindForRoundStatus sibling.
//
// The mapping is deliberately a PURE round-status → nav-kind projection; the
// backend gates the 'awaiting' result further on the task not being dead (see
// the rfc161 backend stamping test).

import { describe, expect, test } from 'bun:test'

import { clarifyNavKindForRoundStatus, NodeRunSchema, type ClarifyRoundStatus } from '../src/index'

describe('RFC-161 clarifyNavKindForRoundStatus', () => {
  test('awaiting_human → awaiting', () => {
    expect(clarifyNavKindForRoundStatus('awaiting_human')).toBe('awaiting')
  })
  test('answered → answered', () => {
    expect(clarifyNavKindForRoundStatus('answered')).toBe('answered')
  })
  test('canceled → null (non-conclusion, deliberately not clickable)', () => {
    expect(clarifyNavKindForRoundStatus('canceled')).toBe(null)
  })
  test('abandoned → null (cross parent-fail, deliberately not clickable)', () => {
    expect(clarifyNavKindForRoundStatus('abandoned')).toBe(null)
  })
  test('undefined (no round) → null (would 404 → not clickable)', () => {
    expect(clarifyNavKindForRoundStatus(undefined)).toBe(null)
  })
  test('null → null', () => {
    expect(clarifyNavKindForRoundStatus(null)).toBe(null)
  })

  // Exhaustive over the ClarifyRoundStatus enum: only the two live states map to
  // a non-null nav kind. A compile-time `satisfies` keeps this honest if the enum grows.
  test('exhaustive over ClarifyRoundStatus', () => {
    const expected: Record<ClarifyRoundStatus, 'awaiting' | 'answered' | null> = {
      awaiting_human: 'awaiting',
      answered: 'answered',
      canceled: null,
      abandoned: null,
    }
    for (const [status, want] of Object.entries(expected)) {
      expect(clarifyNavKindForRoundStatus(status as ClarifyRoundStatus)).toBe(want)
    }
  })
})

describe('RFC-161 NodeRunSchema.clarifyNavKind shape', () => {
  const base = {
    seq: 1,
    id: 'r1',
    taskId: 't1',
    nodeId: 'n1',
    parentNodeRunId: null,
    iteration: 0,
    shardKey: null,
    retryIndex: 0,
    status: 'awaiting_human' as const,
    startedAt: 1,
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

  test("accepts 'awaiting' | 'answered' | null", () => {
    for (const v of ['awaiting', 'answered', null] as const) {
      const parsed = NodeRunSchema.parse({ ...base, clarifyNavKind: v })
      expect(parsed.clarifyNavKind).toBe(v)
    }
  })

  test('absent ⇒ no synthesized key (old daemon / non-clarify rows)', () => {
    const parsed = NodeRunSchema.parse(base)
    expect('clarifyNavKind' in parsed).toBe(false)
  })

  test('rejects an unknown nav kind', () => {
    expect(() => NodeRunSchema.parse({ ...base, clarifyNavKind: 'decided' })).toThrow()
  })
})
