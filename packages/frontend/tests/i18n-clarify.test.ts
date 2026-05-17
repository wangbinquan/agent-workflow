// RFC-023 PR-C T26 — i18n completeness for the clarify namespace.
//
// One assertion: every key path in zh-CN's `clarify` subtree exists in
// en-US with the same key path, and vice versa. The bilingual mirror is
// the test surface — any new key forgotten in one locale breaks this and
// surfaces in CI before users hit a raw key in the UI.

import { describe, expect, it } from 'vitest'
import { zhCN } from '../src/i18n/zh-CN'
import { enUS } from '../src/i18n/en-US'

function flatten(obj: unknown, prefix = ''): string[] {
  if (obj === null || typeof obj !== 'object') return [prefix]
  const out: string[] = []
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const next = prefix.length === 0 ? k : `${prefix}.${k}`
    out.push(...flatten(v, next))
  }
  return out
}

describe('i18n.clarify bilingual completeness', () => {
  it('zh-CN and en-US carry the same set of clarify.* key paths', () => {
    const zh = flatten(zhCN.clarify, 'clarify').sort()
    const en = flatten(enUS.clarify, 'clarify').sort()
    expect(zh).toEqual(en)
    // Sanity floor: design.md §12 budgets ~30 keys; allow some growth.
    expect(zh.length).toBeGreaterThanOrEqual(25)
  })

  it('the four documented inspector keys are present in both locales', () => {
    expect(zhCN.clarify.inspector.title.length).toBeGreaterThan(0)
    expect(zhCN.clarify.inspector.linkedAgentMissing.length).toBeGreaterThan(0)
    expect(enUS.clarify.inspector.title.length).toBeGreaterThan(0)
    expect(enUS.clarify.inspector.linkedAgentMissing.length).toBeGreaterThan(0)
  })

  it('the question kind labels exist (custom row), required by QuestionForm', () => {
    expect(zhCN.clarify.question.single.customLabel.length).toBeGreaterThan(0)
    expect(zhCN.clarify.question.multi.customLabel.length).toBeGreaterThan(0)
    expect(enUS.clarify.question.single.customLabel.length).toBeGreaterThan(0)
    expect(enUS.clarify.question.multi.customLabel.length).toBeGreaterThan(0)
  })
})
