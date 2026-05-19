// RFC-042 — decideEnvelopeFollowup truth-table coverage.
//
// Pure-function tests for the same-session envelope follow-up branch decision.
// 8 cases mapped to design.md §5.2 (front-half). The scheduler integration
// half lives separately under scheduler-envelope-followup-* tests; this file
// only covers the pure function so the truth table cannot regress silently.

import { describe, expect, test } from 'bun:test'

import { decideEnvelopeFollowup, type PreviousAttemptShape } from '@/services/scheduler'

const BASE: PreviousAttemptShape = {
  status: 'failed',
  exitCode: 0,
  errorMessage: 'no <workflow-output> envelope found in stdout',
  sessionId: 'opc_session_abc',
  agentTextCount: 10,
}

describe('RFC-042 decideEnvelopeFollowup', () => {
  // §5.2 case 1
  test('envelope-missing happy path → followup, reason=envelope-missing', () => {
    expect(decideEnvelopeFollowup(BASE)).toEqual({
      followup: true,
      reason: 'envelope-missing',
      failures: [],
    })
  })

  // §5.2 case 2
  test('crashed opencode (exitCode !== 0) → no followup', () => {
    expect(decideEnvelopeFollowup({ ...BASE, exitCode: 137 })).toEqual({ followup: false })
  })

  // §5.2 case 3
  test('no captured sessionId → no followup', () => {
    expect(decideEnvelopeFollowup({ ...BASE, sessionId: null })).toEqual({ followup: false })
    expect(decideEnvelopeFollowup({ ...BASE, sessionId: '' })).toEqual({ followup: false })
  })

  // §5.2 case 4
  test('no agent text emitted → no followup', () => {
    expect(decideEnvelopeFollowup({ ...BASE, agentTextCount: 0 })).toEqual({ followup: false })
  })

  // §5.2 case 5
  test('clarify-and-output-both-present errMsg → followup, reason=both-present', () => {
    expect(
      decideEnvelopeFollowup({
        ...BASE,
        errorMessage:
          'clarify-and-output-both-present: agent reply contained BOTH <workflow-output> and <workflow-clarify>',
      }),
    ).toEqual({ followup: true, reason: 'both-present', failures: [] })
  })

  // §5.2 case 6
  test('clarify-questions-* malformed errMsg → followup, reason=clarify-malformed', () => {
    expect(
      decideEnvelopeFollowup({
        ...BASE,
        errorMessage: 'clarify-questions-too-many: 6/5',
      }),
    ).toEqual({ followup: true, reason: 'clarify-malformed', failures: [] })
    expect(
      decideEnvelopeFollowup({
        ...BASE,
        errorMessage: 'clarify-questions-malformed: empty body',
      }),
    ).toEqual({ followup: true, reason: 'clarify-malformed', failures: [] })
  })

  // §5.2 case 7
  test('non-envelope errorMessage prefixes do not trigger followup', () => {
    expect(
      decideEnvelopeFollowup({
        ...BASE,
        errorMessage: 'opencode exited with code 0',
      }),
    ).toEqual({ followup: false })
    expect(
      decideEnvelopeFollowup({
        ...BASE,
        errorMessage: 'node-timeout: exceeded 60000ms',
      }),
    ).toEqual({ followup: false })
    expect(
      decideEnvelopeFollowup({
        ...BASE,
        errorMessage: null,
      }),
    ).toEqual({ followup: false })
  })

  // §5.2 case 8
  test('non-failed status (done/canceled/null) → no followup', () => {
    expect(decideEnvelopeFollowup({ ...BASE, status: 'done' })).toEqual({ followup: false })
    expect(decideEnvelopeFollowup({ ...BASE, status: 'canceled' })).toEqual({ followup: false })
    expect(decideEnvelopeFollowup({ ...BASE, status: null })).toEqual({ followup: false })
  })
})
