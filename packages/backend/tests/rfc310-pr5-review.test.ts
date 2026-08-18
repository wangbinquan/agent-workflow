// RFC-310 PR-5 T58 —— change.review 契约（envelope schema + semantic validator）。
//
// 锁：①review 是 read-only completed 形态——changed union 里没有 review 成员
// （schema 层就无法伪装成写动作结果）；②reviewedCandidateRef 必须命中平台闭集
// 注入的当前 candidateRef——陈旧树的 findings 整体拒收；③findingId 唯一；
// ④findings 是素材不是裁决：validator 只校对拍与结构，通过与否由平台 policy
// 决定（不存在「Agent 说 clean 就放行」的通道）。链驱动的自动 review 排程与
// verification.repair 同依赖 verification 结果升 catalog fact，属 PR-6 注记。

import { describe, expect, test } from 'bun:test'

import { agentOutcomeEnvelopeSchema } from '../src/modules/development-automation/domain/agentEnvelope'
import { runCapabilitySemanticValidator } from '../src/modules/development-automation/engine/envelope/semanticValidators'
import { makeManifest } from './helpers/rfc310Pr4Manifest'

const CANDIDATE = 'a'.repeat(64)

const HEADER = {
  protocolVersion: 1,
  nonce: 'nonce-0123456789abcdef',
  port: 'agent-result',
  actionRunRef: 'run-1',
  inputDigest: 'd'.repeat(64),
  capabilityId: 'change.review',
} as const

function finding(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    findingId: id,
    path: 'src/Main.java',
    severity: 'major',
    disposition: 'should-fix',
    summary: 'possible NPE on empty input',
    ...overrides,
  }
}

function reviewEnvelope(overrides: Record<string, unknown> = {}): unknown {
  return {
    ...HEADER,
    outcome: 'completed',
    result: {
      capabilityId: 'change.review',
      summary: 'reviewed the candidate diff',
      reviewedCandidateRef: CANDIDATE,
      findings: [finding('f-1')],
      ...overrides,
    },
  }
}

describe('rfc310 pr5 T58 — review envelope schema', () => {
  test('valid review parses; empty findings (clean review) is legal; caps bind', () => {
    expect(agentOutcomeEnvelopeSchema.safeParse(reviewEnvelope()).success).toBe(true)
    expect(agentOutcomeEnvelopeSchema.safeParse(reviewEnvelope({ findings: [] })).success).toBe(
      true,
    )
    // severity/disposition 闭集之外拒。
    expect(
      agentOutcomeEnvelopeSchema.safeParse(
        reviewEnvelope({ findings: [finding('f-1', { severity: 'catastrophic' })] }),
      ).success,
    ).toBe(false)
    expect(
      agentOutcomeEnvelopeSchema.safeParse(
        reviewEnvelope({ findings: [finding('f-1', { disposition: 'auto-approve' })] }),
      ).success,
    ).toBe(false)
    // 审阅锚必须是 64hex digest。
    expect(
      agentOutcomeEnvelopeSchema.safeParse(reviewEnvelope({ reviewedCandidateRef: 'HEAD' }))
        .success,
    ).toBe(false)
    // findings bounded（>200 拒）。
    expect(
      agentOutcomeEnvelopeSchema.safeParse(
        reviewEnvelope({
          findings: Array.from({ length: 201 }, (_, i) => finding(`f-${i}`)),
        }),
      ).success,
    ).toBe(false)
  })

  test('review cannot masquerade as a write result: changed union has no review member', () => {
    const forged = {
      ...HEADER,
      outcome: 'changed',
      changedPaths: ['src/Main.java'],
      result: {
        capabilityId: 'change.review',
        summary: 'sneaky write',
        reviewedCandidateRef: CANDIDATE,
        findings: [],
      },
    }
    expect(agentOutcomeEnvelopeSchema.safeParse(forged).success).toBe(false)
  })
})

describe('rfc310 pr5 T58 — review semantic validator', () => {
  const manifest = makeManifest({ capabilityId: 'change.review' })
  const run = (envelopeOverrides: Record<string, unknown>, candidateRef?: string) => {
    const envelope = agentOutcomeEnvelopeSchema.parse(reviewEnvelope(envelopeOverrides))
    return runCapabilitySemanticValidator({
      manifest,
      envelope,
      closedRefs: candidateRef === undefined ? {} : { candidateRef },
    })
  }

  test('anchor mismatch, missing anchor, duplicate findings are typed rejections; exact anchor passes', () => {
    // 闭集未注入 → validator-input-missing（不是静默通过）。
    expect(run({})).toMatchObject({
      ok: false,
      rejection: { code: 'validator-input-missing' },
    })
    // 陈旧树的审阅整体无效。
    expect(run({ reviewedCandidateRef: 'b'.repeat(64) }, CANDIDATE)).toMatchObject({
      ok: false,
      rejection: { code: 'review-candidate-mismatch', expected: CANDIDATE },
    })
    // findingId 必须唯一。
    expect(
      run({ findings: [finding('f-1'), finding('f-1', { path: 'other.java' })] }, CANDIDATE),
    ).toMatchObject({ ok: false, rejection: { code: 'review-finding-duplicate' } })
    // 对拍命中 → 通过（findings 内容是素材，通过与否归 policy，不在此裁决）。
    expect(run({}, CANDIDATE)).toEqual({ ok: true })
    expect(run({ findings: [] }, CANDIDATE)).toEqual({ ok: true })
  })
})
