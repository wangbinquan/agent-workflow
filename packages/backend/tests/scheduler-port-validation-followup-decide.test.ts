// RFC-049 — decideEnvelopeFollowup port-validation branch coverage.
//
// Pure-function tests for the same-session followup decision when the prior
// attempt failed port content validation. RFC-145: the decision anchor moved
// from the `port-validation-<kind>-<sub>:` errorMessage prefix to
// failureCode='port-validation-failed'（runner 在 PortValidationError 处置码；
// <kind>/<sub> 细节继续走 port_validation_failures_json 载荷列）。Cases:
//   * followup fires with the failures array forwarded（各 subReason 同码——
//     子理由是载荷不是路由键）.
//   * The 3 RFC-042 prerequisites are still respected — non-zero exit,
//     missing sessionId, no agent text all suppress the followup.
//   * Degraded mode: code present but the failures column is missing (or
//     returned null from parsePortValidationFailuresJson). The followup still
//     fires; failures is the empty array.

import { describe, expect, test } from 'bun:test'

import { decideEnvelopeFollowup, type PreviousAttemptShape } from '@/services/scheduler'

const BASE: PreviousAttemptShape = {
  status: 'failed',
  exitCode: 0,
  failureCode: 'port-validation-failed',
  sessionId: 'opc_session_xyz',
  agentTextCount: 5,
}

describe('RFC-049 decideEnvelopeFollowup port-validation', () => {
  const FAILURE = {
    port: 'docpath',
    kind: 'markdown_file',
    subReason: 'missing-file',
    detail: "markdown_file 'docpath.md': ENOENT",
  }

  test('missing-file → followup with reason=port-validation and failures threaded through', () => {
    expect(decideEnvelopeFollowup({ ...BASE, portValidationFailures: [FAILURE] })).toEqual({
      followup: true,
      reason: 'port-validation',
      failures: [FAILURE],
    })
  })

  for (const sub of ['empty-path', 'escapes-worktree', 'wrong-extension', 'empty-file'] as const) {
    test(`subReason ${sub} also maps to followup`, () => {
      const failure = { port: 'p', kind: 'markdown_file', subReason: sub }
      const d = decideEnvelopeFollowup({
        ...BASE,
        portValidationFailures: [failure],
      })
      expect(d).toEqual({
        followup: true,
        reason: 'port-validation',
        failures: [failure],
      })
    })
  }

  test('exitCode !== 0 → no followup (RFC-042 invariant preserved)', () => {
    expect(
      decideEnvelopeFollowup({ ...BASE, exitCode: 137, portValidationFailures: [FAILURE] }),
    ).toEqual({ followup: false })
  })

  test('sessionId missing → no followup (RFC-042 invariant preserved)', () => {
    expect(
      decideEnvelopeFollowup({ ...BASE, sessionId: null, portValidationFailures: [FAILURE] }),
    ).toEqual({ followup: false })
  })

  test('agentTextCount === 0 → no followup (RFC-042 invariant preserved)', () => {
    expect(
      decideEnvelopeFollowup({ ...BASE, agentTextCount: 0, portValidationFailures: [FAILURE] }),
    ).toEqual({ followup: false })
  })

  test('code present but failures column missing → degraded followup with []', () => {
    // Field omitted entirely (pre-RFC-049 row, or parsePortValidationFailuresJson
    // returned null and the caller coerced to undefined).
    expect(decideEnvelopeFollowup({ ...BASE })).toEqual({
      followup: true,
      reason: 'port-validation',
      failures: [],
    })
  })

  test('非 port-validation 码不携带 failures（载荷只随该码转发）', () => {
    const failure = { port: 'p', kind: 'markdown_file', subReason: 'empty-file' }
    expect(
      decideEnvelopeFollowup({
        ...BASE,
        failureCode: 'envelope-missing',
        portValidationFailures: [failure],
      }),
    ).toEqual({
      followup: true,
      reason: 'envelope-missing',
      failures: [],
    })
  })
})
