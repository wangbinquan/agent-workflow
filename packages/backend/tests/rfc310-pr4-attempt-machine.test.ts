// RFC-310 PR-4 T42/T49 —— AgentAttempt 状态机与两级预算锁（§7.7 分类表）。

import { describe, expect, test } from 'bun:test'

import {
  AGENT_ATTEMPT_STATUSES,
  ATTEMPT_TRANSITIONS,
  attemptFeedbackSchema,
  checkAttemptTransition,
  decodeAgentAttemptBaselineRef,
  encodeAgentAttemptBaselineRef,
  nonceDigestOf,
  planNextAttempt,
} from '../src/modules/development-automation/domain/agentAttempt'

describe('rfc310 pr4 — attempt state machine', () => {
  test('transition table is exhaustive and terminal states absorb', () => {
    for (const from of AGENT_ATTEMPT_STATUSES) {
      expect(ATTEMPT_TRANSITIONS[from]).toBeDefined()
    }
    expect(checkAttemptTransition({ from: 'claimed', to: 'running' }).ok).toBe(true)
    expect(checkAttemptTransition({ from: 'running', to: 'validated' }).ok).toBe(true)
    expect(checkAttemptTransition({ from: 'running', to: 'rejected' }).ok).toBe(true)
    expect(checkAttemptTransition({ from: 'claimed', to: 'validated' }).ok).toBe(false)
    for (const terminal of ['rejected', 'validated', 'interrupted', 'discarded'] as const) {
      for (const to of AGENT_ATTEMPT_STATUSES) {
        expect(checkAttemptTransition({ from: terminal, to }).ok).toBe(false)
      }
    }
  })

  test('protocol failures retry same-session until the budget, then go fresh with attemptSeq reset', () => {
    const budget = { sameSession: 2, freshSession: 1 }
    expect(planNextAttempt({ failure: 'protocol', budget, rerunSeq: 0, attemptSeq: 0 })).toEqual({
      kind: 'same-session',
      rerunSeq: 0,
      attemptSeq: 1,
    })
    expect(planNextAttempt({ failure: 'protocol', budget, rerunSeq: 0, attemptSeq: 2 })).toEqual({
      kind: 'fresh-session',
      rerunSeq: 1,
      attemptSeq: 0,
    })
    expect(planNextAttempt({ failure: 'protocol', budget, rerunSeq: 1, attemptSeq: 2 })).toEqual({
      kind: 'exhausted',
      blockCode: 'agent-contract-exhausted',
    })
  })

  test('boundary violations never retry same-session', () => {
    const budget = { sameSession: 5, freshSession: 1 }
    expect(
      planNextAttempt({ failure: 'boundary-violation', budget, rerunSeq: 0, attemptSeq: 0 }),
    ).toEqual({ kind: 'fresh-session', rerunSeq: 1, attemptSeq: 0 })
    expect(
      planNextAttempt({ failure: 'boundary-violation', budget, rerunSeq: 1, attemptSeq: 0 }),
    ).toEqual({ kind: 'exhausted', blockCode: 'agent-contract-exhausted' })
  })

  test('evidence-unavailable and superseded are forbidden outright', () => {
    const budget = { sameSession: 5, freshSession: 5 }
    expect(
      planNextAttempt({ failure: 'evidence-unavailable', budget, rerunSeq: 0, attemptSeq: 0 }),
    ).toEqual({ kind: 'forbidden', blockCode: 'evidence-unavailable' })
    expect(planNextAttempt({ failure: 'superseded', budget, rerunSeq: 0, attemptSeq: 0 })).toEqual({
      kind: 'forbidden',
      blockCode: 'attempt-superseded',
    })
  })

  test('baseline composite ref round-trips and rejects tampering', () => {
    const baseline = {
      repositorySnapshotRef: 'git:' + 'a'.repeat(40),
      seedChangeRef: 'seed-1',
      priorChangeSetRefs: ['cs-1', 'cs-2'],
    }
    const ref = encodeAgentAttemptBaselineRef(baseline)
    expect(ref.startsWith('ab1:')).toBe(true)
    expect(decodeAgentAttemptBaselineRef(ref)).toEqual(baseline)
    expect(decodeAgentAttemptBaselineRef('ab1:not-base64-json')).toBeNull()
    expect(decodeAgentAttemptBaselineRef('other:xxx')).toBeNull()
  })

  test('nonce ledger form is a digest; feedback stays structured and bounded', () => {
    expect(nonceDigestOf('nonce-0123456789abcdef')).toMatch(/^[0-9a-f]{64}$/)
    expect(
      attemptFeedbackSchema.safeParse({
        code: 'schema-invalid',
        jsonPointer: '/result/summary',
        expected: 'non-empty string',
        observedSummary: 'summary was empty',
        retryOrdinal: 1,
      }).success,
    ).toBe(true)
    expect(
      attemptFeedbackSchema.safeParse({
        code: 'schema-invalid',
        jsonPointer: null,
        expected: null,
        observedSummary: 'x',
        retryOrdinal: 0,
        rawLog: 'leak',
      }).success,
    ).toBe(false)
  })
})
