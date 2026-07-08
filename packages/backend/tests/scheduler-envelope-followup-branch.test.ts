// RFC-042 — decideEnvelopeFollowup truth-table coverage.
//
// Pure-function tests for the same-session envelope follow-up branch decision.
// 8 cases mapped to design.md §5.2 (front-half). The scheduler integration
// half lives separately under scheduler-envelope-followup-* tests; this file
// only covers the pure function so the truth table cannot regress silently.
//
// RFC-145: the decision input switched from errorMessage PREFIX PARSING to the
// structured `failureCode` column (runner declares it at the stamp point;
// FOLLOWUP_POLICY projects 7 producer codes onto 6 render reasons). The truth
// table below is the SAME semantic table as the RFC-042 original, translated
// message-fixture → code-fixture; the "unrecognized errorMessage → no
// followup" case became "failureCode NULL → no followup" (which now also
// covers clarify-options-* style validator codes — D8 keeps them unstamped).

import { describe, expect, test } from 'bun:test'

import { decideEnvelopeFollowup, type PreviousAttemptShape } from '@/services/scheduler'

const BASE: PreviousAttemptShape = {
  status: 'failed',
  exitCode: 0,
  failureCode: 'envelope-missing',
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
  test('clarify-and-output-both → followup, reason=both-present', () => {
    expect(decideEnvelopeFollowup({ ...BASE, failureCode: 'clarify-and-output-both' })).toEqual({
      followup: true,
      reason: 'both-present',
      failures: [],
    })
  })

  // §5.2 case 6（clarify-questions-* 码族在产出侧折叠为单一 code——D8：
  // clarify-options-* 等无 follow-up 码不置码，落 case 7 的 NULL 分支）
  test('clarify-questions-malformed → followup, reason=clarify-malformed', () => {
    expect(decideEnvelopeFollowup({ ...BASE, failureCode: 'clarify-questions-malformed' })).toEqual(
      { followup: true, reason: 'clarify-malformed', failures: [] },
    )
  })

  // RFC-100: mandatory ask-back violations → same-session followup that
  // re-demands the clarify envelope（三个 message 变体在产出侧同码）.
  test('clarify-required → followup, reason=clarify-required', () => {
    expect(decideEnvelopeFollowup({ ...BASE, failureCode: 'clarify-required' })).toEqual({
      followup: true,
      reason: 'clarify-required',
      failures: [],
    })
  })

  // 损坏端口急修（2026-06-24）: a <port> was opened but never closed with a
  // parseable </port> → same-session followup so the agent re-emits a clean
  // envelope instead of silently completing with a blank port.
  test('envelope-port-malformed → followup, reason=envelope-port-malformed', () => {
    expect(decideEnvelopeFollowup({ ...BASE, failureCode: 'envelope-port-malformed' })).toEqual({
      followup: true,
      reason: 'envelope-port-malformed',
      failures: [],
    })
  })

  // RFC-123: clarify-forbidden（stop 后仍问）——投影表的显式降级格：渲染为
  // envelope-missing（stop 轮 hasClarify=false，正确指令就是「给我 output」）。
  test('clarify-forbidden → followup, reason=envelope-missing（显式降级）', () => {
    expect(decideEnvelopeFollowup({ ...BASE, failureCode: 'clarify-forbidden' })).toEqual({
      followup: true,
      reason: 'envelope-missing',
      failures: [],
    })
  })

  // §5.2 case 7 — 无机器可读失败形态（含 D8 的 clarify-options-* 类、超时、
  // 常规异常等：runner 不置码 → NULL → 不 follow-up）。
  test('failureCode NULL → no followup', () => {
    expect(decideEnvelopeFollowup({ ...BASE, failureCode: null })).toEqual({ followup: false })
  })

  // §5.2 case 8
  test('non-failed status (done/canceled/null) → no followup', () => {
    expect(decideEnvelopeFollowup({ ...BASE, status: 'done' })).toEqual({ followup: false })
    expect(decideEnvelopeFollowup({ ...BASE, status: 'canceled' })).toEqual({ followup: false })
    expect(decideEnvelopeFollowup({ ...BASE, status: null })).toEqual({ followup: false })
  })
})
