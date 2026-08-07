// RFC-264 — locks the human-readable name rule for workflow + workgroup.
//
// Replaces the 2026-07-10 slug rule `^[a-z0-9][a-z0-9_-]*$` (user report:
// 「工作组、工作流名称要能支持中文」). What must never regress:
//   1. Chinese / mixed-script / uppercase / punctuation / emoji names pass, and
//      every name legal under the OLD slug rule still passes (zero migration).
//   2. The invisible-character family is REJECTED, not silently cleaned —
//      a multi-line paste must error instead of being joined into one line.
//   3. Normalization is idempotent and folds exactly the equivalences that
//      would otherwise render identically (NFC, `\p{Zs}`, runs, edges).
//   4. The 128 bound counts CODE POINTS (the `u` flag makes the quantifier do
//      that) — a UTF-16 `.max()` would disagree for astral-plane names.
//   5. WORKFLOW_NAME_RE and WORKGROUP_NAME_RE stay the SAME object, so the two
//      resources can never drift apart again.

import { describe, expect, test } from 'bun:test'
import {
  IntentWorkflowPayloadSchema,
  isValidResourceDisplayName,
  normalizeResourceDisplayName,
  RESOURCE_DISPLAY_NAME_MAX,
  RESOURCE_DISPLAY_NAME_RE,
  ResourceDisplayNameSchema,
  WORKFLOW_NAME_RE,
  WORKGROUP_NAME_RE,
  WorkflowNameSchema,
  validateFinalNameForType,
  WorkgroupNameSchema,
} from '../src/index'

/** Parse through the real schema: normalization happens on parse. */
function parseName(raw: string): { ok: true; value: string } | { ok: false } {
  const parsed = ResourceDisplayNameSchema.safeParse(raw)
  return parsed.success ? { ok: true, value: parsed.data as string } : { ok: false }
}

describe('RFC-264 charset — accepted', () => {
  const accepted = [
    ['pure Han', '代码审计流水线'],
    ['Han + Latin + digits + spaces', '审计 Pipeline v2'],
    ['full-width punctuation', 'Code Review（重构专用）'],
    ['legacy slug (zero migration)', 'my-workflow'],
    ['legacy slug with underscore', 'code_audit_flow'],
    ['single character', 'a'],
    ['single ideograph', '组'],
    ['uppercase Latin', 'CodeReview'],
    ['emoji', 'emoji🎯名'],
    ['kana', 'コードレビュー'],
    ['inner underscore', 'a_b'],
    ['leading hyphen', '-dash-start'],
    ['CJK punctuation', '审计·流程：第一阶段'],
  ] as const

  for (const [label, name] of accepted) {
    test(`accepts ${label}: ${JSON.stringify(name)}`, () => {
      expect(isValidResourceDisplayName(name)).toBe(true)
      const parsed = parseName(name)
      expect(parsed.ok).toBe(true)
      if (parsed.ok) expect(parsed.value).toBe(name)
    })
  }
})

describe('RFC-264 charset — rejected', () => {
  const rejected = [
    ['empty', ''],
    ['all whitespace', '   '],
    ['all ideographic spaces', '　　'],
    ['leading underscore', '_foo'],
    ['framework builtin shape', '__workgroup_host__'],
    ['inner newline', 'a\nb'],
    ['inner tab', 'a\tb'],
    ['inner carriage return', 'a\rb'],
    ['zero-width space', `zero​width`],
    ['RTL override', `rtl‮override`],
    ['line separator', `a b`],
    ['paragraph separator', `a b`],
    ['private use area', `puaname`],
    ['lone surrogate', `broken\ud83c`],
  ] as const

  for (const [label, name] of rejected) {
    test(`rejects ${label}: ${JSON.stringify(name)}`, () => {
      expect(parseName(name).ok).toBe(false)
    })
  }

  test('rejects 129 code points, accepts 128', () => {
    expect(parseName('审'.repeat(RESOURCE_DISPLAY_NAME_MAX)).ok).toBe(true)
    expect(parseName('审'.repeat(RESOURCE_DISPLAY_NAME_MAX + 1)).ok).toBe(false)
  })

  test('the bound counts CODE POINTS, not UTF-16 units', () => {
    // 128 astral-plane characters = 256 UTF-16 units. A `.max(128)` on the
    // string length would wrongly reject this.
    const astral = '🎯'.repeat(RESOURCE_DISPLAY_NAME_MAX)
    expect(astral.length).toBe(RESOURCE_DISPLAY_NAME_MAX * 2)
    expect(parseName(astral).ok).toBe(true)
    expect(parseName('🎯'.repeat(RESOURCE_DISPLAY_NAME_MAX + 1)).ok).toBe(false)
  })
})

describe('RFC-264 normalization', () => {
  const cases = [
    ['trailing space', '代码审计 ', '代码审计'],
    ['leading space', ' 代码审计', '代码审计'],
    ['ideographic space U+3000', '审计　Pipeline', '审计 Pipeline'],
    ['non-breaking space U+00A0', '审计 Pipeline', '审计 Pipeline'],
    ['collapsed run', '审计  流程', '审计 流程'],
    ['collapsed full-width run', '审计　　流程', '审计 流程'],
    ['trailing newline from a paste', '审计\n', '审计'],
    ['no-op for a plain name', '代码审计流水线', '代码审计流水线'],
  ] as const

  for (const [label, raw, expected] of cases) {
    test(`${label}: ${JSON.stringify(raw)} → ${JSON.stringify(expected)}`, () => {
      expect(normalizeResourceDisplayName(raw)).toBe(expected)
      const parsed = parseName(raw)
      expect(parsed.ok).toBe(true)
      if (parsed.ok) expect(parsed.value).toBe(expected)
    })
  }

  test('is idempotent over every case in this file', () => {
    const inputs = [
      '代码审计 ',
      ' 代码审计',
      '审计　Pipeline',
      '审计  流程',
      '审计\n',
      '代码审计流水线',
      'a\nb',
      '   ',
      '_foo',
      'emoji🎯名',
    ]
    for (const input of inputs) {
      const once = normalizeResourceDisplayName(input)
      expect(normalizeResourceDisplayName(once)).toBe(once)
    }
  })

  test('NFC is the identity for Han ideographs', () => {
    const han = '代码审计'
    expect(han.normalize('NFD')).toBe(han)
    expect(normalizeResourceDisplayName(han)).toBe(han)
  })

  test('NFC folds decomposed Latin so two rows cannot look identical', () => {
    const decomposed = 'équipe' // e + combining acute
    const composed = 'équipe'
    expect(decomposed).not.toBe(composed)
    expect(normalizeResourceDisplayName(decomposed)).toBe(composed)
  })

  test('an INNER newline survives normalization so it can be rejected', () => {
    // The friendly path is trimming a pasted trailing newline; silently
    // joining a multi-line paste into one line is not friendly, it is a lie.
    expect(normalizeResourceDisplayName('审计\n流程')).toBe('审计\n流程')
    expect(parseName('审计\n流程').ok).toBe(false)
  })
})

describe('RFC-264 aliasing — workflow and workgroup can never drift', () => {
  test('all three regex exports are the SAME object', () => {
    expect(WORKFLOW_NAME_RE).toBe(RESOURCE_DISPLAY_NAME_RE)
    expect(WORKGROUP_NAME_RE).toBe(RESOURCE_DISPLAY_NAME_RE)
  })

  test('both name schemas are the SAME object', () => {
    expect(WorkflowNameSchema).toBe(ResourceDisplayNameSchema)
    expect(WorkgroupNameSchema).toBe(ResourceDisplayNameSchema)
  })

  test('both schemas normalize on parse', () => {
    expect(WorkflowNameSchema.parse('代码审计 ')).toBe('代码审计')
    expect(WorkgroupNameSchema.parse('审计　组')).toBe('审计 组')
  })

  test('.optional() still chains (scheduledTask.workgroupName relies on it)', () => {
    const optional = WorkgroupNameSchema.optional()
    expect(optional.parse(undefined)).toBeUndefined()
    expect(optional.parse('代码审计组 ')).toBe('代码审计组')
  })
})

// RFC-264 — the `/intent` changeset path had a THIRD private name rule for
// workflow/workgroup (`max(200)`, control chars only). Those ops write straight
// through to the row, so a laxer grammar there could mint a name the rest of the
// product cannot represent: `_`-prefixed (the framework-row shape) or past the
// 128-code-point bound. Now it is the same rule, from the same module.
describe('RFC-264 — the intent changeset path shares the canonical rule', () => {
  test('workflow / workgroup finalName follows the shared rule', () => {
    expect(validateFinalNameForType('workflow', '代码审计流水线')).toBeNull()
    expect(validateFinalNameForType('workgroup', '审计 Pipeline v2')).toBeNull()
    // Folded before judging, exactly like every other entry point.
    expect(validateFinalNameForType('workflow', '代码审计 ')).toBeNull()
    // The two cases the old `max(200)` grammar let through:
    expect(validateFinalNameForType('workflow', '_reserved')).not.toBeNull()
    expect(validateFinalNameForType('workgroup', '审'.repeat(129))).not.toBeNull()
    // Still rejected, as before:
    expect(validateFinalNameForType('workflow', 'two\nlines')).not.toBeNull()
    expect(validateFinalNameForType('workflow', '   ')).not.toBeNull()
  })

  test('agent / skill / mcp / plugin keep the ASCII slug rule', () => {
    expect(validateFinalNameForType('agent', 'code-auditor')).toBeNull()
    expect(validateFinalNameForType('agent', '代码审计')).not.toBeNull()
    expect(validateFinalNameForType('skill', 'lint')).toBeNull()
    expect(validateFinalNameForType('mcp', 'Bad Name')).not.toBeNull()
  })

  test('the op payload schemas normalize the name on parse', () => {
    const workflow = IntentWorkflowPayloadSchema.safeParse({
      name: '代码审计  流水线 ',
      description: '',
      definition: { $schema_version: 4, inputs: [], nodes: [], edges: [] },
    })
    expect(workflow.success).toBe(true)
    if (workflow.success) expect(workflow.data.name).toBe('代码审计 流水线')

    const bad = IntentWorkflowPayloadSchema.safeParse({
      name: '_reserved',
      description: '',
      definition: { $schema_version: 4, inputs: [], nodes: [], edges: [] },
    })
    expect(bad.success).toBe(false)
  })
})
