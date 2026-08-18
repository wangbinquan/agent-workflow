// RFC-310 PR-4 T46 —— transport parser 锁（§7.5 步骤 1-3）。
//
// exactly-one frame、tag/JSON 双 nonce、strict schema（冒充平台事实的字段按
// unknown key 拒）、exact identity 对拍。rejection 是 typed 结构化反馈素材：
// nonce mismatch 不回显期望值（nonce 是 secret）。

import { describe, expect, test } from 'bun:test'

import {
  parseAgentFrame,
  type ExpectedFrameIdentity,
} from '../src/modules/development-automation/engine/envelope/parseAgentFrame'
import { nonceDigestOf } from '../src/modules/development-automation/domain/agentAttempt'

// 平台侧只持 digest（§7.1）：期望身份是 nonceDigest，明文由 Agent 回显。
const NONCE = 'nonce-0123456789abcdef'
const EXPECTED: ExpectedFrameIdentity = {
  nonceDigest: nonceDigestOf(NONCE),
  actionRunRef: 'run-1',
  inputDigest: 'd'.repeat(64),
  capabilityId: 'change.implement',
}

function envelopeJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    protocolVersion: 1,
    nonce: NONCE,
    port: 'agent-result',
    actionRunRef: EXPECTED.actionRunRef,
    inputDigest: EXPECTED.inputDigest,
    capabilityId: EXPECTED.capabilityId,
    outcome: 'changed',
    result: {
      capabilityId: 'change.implement',
      summary: 'implemented the widget',
      requirementCoverage: [{ itemRef: 'item-1', disposition: 'implemented' }],
    },
    ...overrides,
  })
}

function frame(json: string, nonce = NONCE): string {
  return `<agent-result nonce="${nonce}">\n${json}\n</agent-result>`
}

const codeOf = (r: ReturnType<typeof parseAgentFrame>): string => (r.ok ? 'ok' : r.rejection.code)

describe('rfc310 pr4 — agent frame transport parser', () => {
  test('happy path: logs around exactly one frame parse to the envelope', () => {
    const out = parseAgentFrame(
      `some runtime log\n${frame(envelopeJson())}\ntrailing log`,
      EXPECTED,
    )
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.envelope.outcome).toBe('changed')
  })

  test('zero frames → frame-missing', () => {
    expect(codeOf(parseAgentFrame('no frame here', EXPECTED))).toBe('frame-missing')
  })

  test('two frames → frame-multiple (exactly-one, not last-wins)', () => {
    const stdout = `${frame(envelopeJson())}\n${frame(envelopeJson())}`
    expect(codeOf(parseAgentFrame(stdout, EXPECTED))).toBe('frame-multiple')
  })

  test('tag nonce mismatch rejects without echoing the expected nonce', () => {
    const out = parseAgentFrame(frame(envelopeJson(), 'wrong-nonce-000000000000'), EXPECTED)
    expect(codeOf(out)).toBe('nonce-mismatch')
    if (!out.ok) {
      expect(out.rejection.expected).toBeNull()
      expect(out.rejection.observedSummary).not.toContain(NONCE)
    }
  })

  test('json nonce mismatch (tag right, body wrong) → nonce-mismatch', () => {
    const body = envelopeJson({ nonce: 'other-nonce-1234567890ab' })
    expect(codeOf(parseAgentFrame(frame(body), EXPECTED))).toBe('nonce-mismatch')
  })

  test('non-JSON body → frame-not-json', () => {
    expect(codeOf(parseAgentFrame(frame('not json at all'), EXPECTED))).toBe('frame-not-json')
  })

  test('platform-fact impersonation fields are rejected as unknown keys with a pointer', () => {
    for (const field of ['changedPaths', 'commitSha', 'pushed', 'testsPassed', 'mergeable']) {
      const out = parseAgentFrame(frame(envelopeJson({ [field]: 'x' })), EXPECTED)
      expect(codeOf(out)).toBe('schema-invalid')
      if (!out.ok) expect(out.rejection.jsonPointer).not.toBeNull()
    }
  })

  test('identity mismatches map to their own codes', () => {
    expect(codeOf(parseAgentFrame(frame(envelopeJson({ actionRunRef: 'other' })), EXPECTED))).toBe(
      'action-run-mismatch',
    )
    expect(
      codeOf(parseAgentFrame(frame(envelopeJson({ inputDigest: 'e'.repeat(64) })), EXPECTED)),
    ).toBe('input-digest-mismatch')
    const otherCapability = envelopeJson({
      capabilityId: 'verification.repair',
      result: { capabilityId: 'verification.repair', summary: 's', failureRefs: ['f-1'] },
    })
    expect(codeOf(parseAgentFrame(frame(otherCapability), EXPECTED))).toBe('capability-mismatch')
  })

  test('header/result capability split personality is a schema failure', () => {
    const split = envelopeJson({
      result: { capabilityId: 'pipeline.repair', summary: 's', issueRefs: ['i-1'] },
    })
    const out = parseAgentFrame(frame(split), EXPECTED)
    expect(codeOf(out)).toBe('schema-invalid')
  })
})
