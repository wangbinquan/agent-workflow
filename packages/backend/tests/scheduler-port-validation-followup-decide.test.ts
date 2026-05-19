// RFC-049 — decideEnvelopeFollowup port-validation branch coverage.
//
// Pure-function tests for the same-session followup decision when the prior
// attempt failed with a `port-validation-<kind>-<sub>:` errorMessage prefix.
// Cases:
//   * 5 markdown_file subReasons each map → followup, reason='port-validation'
//     with the failures array forwarded.
//   * The 3 RFC-042 prerequisites are still respected — non-zero exit,
//     missing sessionId, no agent text all suppress the followup.
//   * Degraded mode: errorMessage matches the prefix but the failures column
//     is missing (or returned null from parsePortValidationFailuresJson).
//     The followup still fires; failures is the empty array.
//   * Unknown kind in the prefix (e.g. `port-validation-code_file-bad`) still
//     triggers a followup because the outer prefix is the decision anchor;
//     downstream composePerKindRepairBlocks degrades the per-kind text.

import { describe, expect, test } from 'bun:test'

import { decideEnvelopeFollowup, type PreviousAttemptShape } from '@/services/scheduler'

const BASE: PreviousAttemptShape = {
  status: 'failed',
  exitCode: 0,
  errorMessage: 'port-validation-markdown_file-missing-file: ...',
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
        errorMessage: `port-validation-markdown_file-${sub}: ...`,
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

  test('errorMessage matches prefix but failures column is missing → degraded followup with []', () => {
    // Field omitted entirely (pre-RFC-049 row, or parsePortValidationFailuresJson
    // returned null and the caller coerced to undefined).
    expect(decideEnvelopeFollowup({ ...BASE })).toEqual({
      followup: true,
      reason: 'port-validation',
      failures: [],
    })
  })

  test('unknown kind in prefix still triggers followup (router degrades downstream)', () => {
    expect(
      decideEnvelopeFollowup({
        ...BASE,
        errorMessage: 'port-validation-code_file-lint-failed: ...',
      }),
    ).toEqual({
      followup: true,
      reason: 'port-validation',
      failures: [],
    })
  })
})
