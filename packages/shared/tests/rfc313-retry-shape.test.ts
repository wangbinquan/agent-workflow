// RFC-313/RFC-334 — shared keeps only session-restart prompt rendering.
// Attempt-cap arithmetic and TaskExecution retry-shape state are exercised in
// packages/backend/tests/rfc334-retry-contract.test.ts after their owner cut.

import { describe, expect, test } from 'bun:test'

import {
  renderSessionRestartNotice,
  renderUserPrompt,
  type EnvelopeFollowupReason,
} from '../src/prompt'

const REASONS: readonly EnvelopeFollowupReason[] = [
  'envelope-missing',
  'both-present',
  'clarify-malformed',
  'port-validation',
  'clarify-required',
  'envelope-port-malformed',
  'branch-marker',
]

describe('RFC-313 renderSessionRestartNotice', () => {
  test('每个 reason 都有非空且互不相同的文案', () => {
    const seen = new Map<string, EnvelopeFollowupReason>()
    for (const reason of REASONS) {
      const text = renderSessionRestartNotice(reason)
      expect(text.length).toBeGreaterThan(0)
      expect(seen.get(text)).toBeUndefined()
      seen.set(text, reason)
    }
    expect(seen.size).toBe(REASONS.length)
  })

  test('文案指向上方指定的格式，而不是一个新会话看不到的历史', () => {
    for (const reason of REASONS) {
      const text = renderSessionRestartNotice(reason)
      expect(text).toContain('specified above')
      expect(text).not.toContain('previously specified in this session')
    }
  })

  test('零用户可控插值', () => {
    for (const reason of REASONS) {
      const text = renderSessionRestartNotice(reason)
      expect(text).not.toContain('${')
      expect(text).not.toContain('errorMessage')
    }
  })
})

describe('RFC-313 renderUserPrompt — 告知的追加', () => {
  const base = {
    promptTemplate: 'do the thing',
    inputs: {},
    agentOutputs: ['summary'],
  }

  test('缺省时输出逐字节等于引入本字段前', () => {
    const withoutField = renderUserPrompt({ ...base })
    const withUndefined = renderUserPrompt({ ...base, priorSessionAbandoned: undefined })
    expect(withUndefined).toBe(withoutField)
    expect(withoutField).not.toContain('Note on an earlier attempt')
  })

  test('给出时追加在协议块之后', () => {
    const rendered = renderUserPrompt({
      ...base,
      priorSessionAbandoned: { reason: 'envelope-missing' },
    })
    const plain = renderUserPrompt({ ...base })
    expect(rendered.startsWith(plain)).toBe(true)
    expect(rendered.slice(plain.length)).toBe(renderSessionRestartNotice('envelope-missing'))
    expect(rendered.indexOf('Note on an earlier attempt')).toBeGreaterThan(
      rendered.indexOf('workflow-output'),
    )
  })
})
