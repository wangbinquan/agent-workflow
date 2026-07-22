// RFC-218 T4 — the shared derivation layer is the single source of truth for
// the port-driven single-agent launch form. These tests lock:
//   1. the kind → WorkflowInput mapping matrix (design.md §2.2, every row),
//   2. the XML port-envelope promptTemplate bytes (design.md §3 golden),
//   3. launch blockers (signal anywhere / non-token names / reserved dunder
//      family / record poison keys — design.md §2.3 + D13),
//   4. required-by-default semantics (D5).
// Zero-port agents must return null so callers stay on the RFC-165 legacy
// description path (structural byte-compat, AC-2).

import { describe, expect, test } from 'bun:test'
import type { AgentInputPort } from '../src/schemas/agent'
import {
  AGENT_LAUNCH_INPUT_MAX_LEN,
  agentInputUploadDir,
  agentLaunchBlockers,
  agentPortRequired,
  buildAgentHostPromptTemplate,
  deriveAgentLaunchForm,
} from '../src/agentLaunchForm'

function port(name: string, kind = 'string', extra: Partial<AgentInputPort> = {}): AgentInputPort {
  return { name, kind, ...extra }
}

describe('deriveAgentLaunchForm — kind mapping matrix (§2.2)', () => {
  test('zero ports / undefined → null (legacy RFC-165 path)', () => {
    expect(deriveAgentLaunchForm(undefined)).toBeNull()
    expect(deriveAgentLaunchForm([])).toBeNull()
  })

  test('string → multiline text with wire-cap maxLength', () => {
    const form = deriveAgentLaunchForm([port('goal', 'string')])!
    expect(form.inputs).toEqual([
      {
        key: 'goal',
        label: 'goal',
        required: true,
        agentKind: 'string',
        kind: 'text',
        multiline: true,
        maxLength: AGENT_LAUNCH_INPUT_MAX_LEN,
      },
    ])
  })

  test('markdown → multiline text; description carries to the def', () => {
    const form = deriveAgentLaunchForm([port('report', 'markdown', { description: '周报正文' })])!
    const def = form.inputs[0]!
    expect(def.kind).toBe('text')
    expect((def as Record<string, unknown>).multiline).toBe(true)
    expect(def.description).toBe('周报正文')
    expect(def.agentKind).toBe('markdown')
  })

  test('path<pdf> → single-file upload with ext accept + platform targetDir', () => {
    const form = deriveAgentLaunchForm([port('attachment', 'path<pdf>')])!
    expect(form.inputs[0]).toEqual({
      key: 'attachment',
      label: 'attachment',
      required: true,
      agentKind: 'path<pdf>',
      kind: 'upload',
      targetDir: '.agent-inputs/attachment',
      accept: ['.pdf'],
      maxCount: 1,
      minCount: 1,
    })
    expect(agentInputUploadDir('attachment')).toBe('.agent-inputs/attachment')
  })

  test('path<*> → upload without accept filter; optional → minCount 0', () => {
    const form = deriveAgentLaunchForm([port('any_file', 'path<*>', { required: false })])!
    const def = form.inputs[0]! as Record<string, unknown>
    expect(def.kind).toBe('upload')
    expect(def.accept).toBeUndefined()
    expect(def.minCount).toBe(0)
    expect(def.required).toBe(false)
  })

  test('list<path<md>> → multi-file upload (no maxCount)', () => {
    const form = deriveAgentLaunchForm([port('docs', 'list<path<md>>')])!
    const def = form.inputs[0]! as Record<string, unknown>
    expect(def.kind).toBe('upload')
    expect(def.accept).toEqual(['.md'])
    expect(def.maxCount).toBeUndefined()
    expect(def.minCount).toBe(1)
  })

  test('list<string> / list<markdown> → chips presentation on text', () => {
    for (const k of ['list<string>', 'list<markdown>']) {
      const form = deriveAgentLaunchForm([port('items', k)])!
      const def = form.inputs[0]! as Record<string, unknown>
      expect(def.kind).toBe('text')
      expect(def.presentation).toBe('chips')
    }
  })

  test('nested list (list<list<string>>) → verbatim multiline text fallback', () => {
    const form = deriveAgentLaunchForm([port('matrix', 'list<list<string>>')])!
    const def = form.inputs[0]! as Record<string, unknown>
    expect(def.kind).toBe('text')
    expect(def.multiline).toBe(true)
    expect(def.presentation).toBeUndefined()
    expect(def.agentKind).toBe('list<list<string>>')
  })

  test('declaration order is preserved', () => {
    const form = deriveAgentLaunchForm([port('b'), port('a'), port('c')])!
    expect(form.inputs.map((d) => d.key)).toEqual(['b', 'a', 'c'])
  })
})

describe('promptTemplate — XML port envelope golden (§3)', () => {
  test('multi-port bytes are locked', () => {
    const tpl = buildAgentHostPromptTemplate([port('report'), port('style_guide')])
    expect(tpl).toBe(
      [
        'Your task inputs are provided in the XML port blocks below.',
        '',
        '<workflow-input>',
        '<port name="report">',
        '{{report}}',
        '</port>',
        '<port name="style_guide">',
        '{{style_guide}}',
        '</port>',
        '</workflow-input>',
      ].join('\n'),
    )
  })

  test('single port also goes through the envelope (no special case)', () => {
    const tpl = buildAgentHostPromptTemplate([port('goal')])
    expect(tpl).toContain('<workflow-input>')
    expect(tpl).toContain('<port name="goal">')
    expect(tpl).toContain('{{goal}}')
  })
})

describe('launch blockers (§2.3 / D13)', () => {
  test('signal at top level and nested inside list both block', () => {
    expect(agentLaunchBlockers([port('go', 'signal')])).toEqual([
      { kind: 'signal-port', port: 'go' },
    ])
    expect(agentLaunchBlockers([port('gos', 'list<signal>')])).toEqual([
      { kind: 'signal-port', port: 'gos' },
    ])
  })

  test('non-token names block (template token regex is \\w+)', () => {
    for (const bad of ['has space', 'kebab-name', '中文名', '1leading', 'dot.name']) {
      const blockers = agentLaunchBlockers([port(bad)])
      expect(blockers).toEqual([{ kind: 'invalid-port-name', port: bad, reason: 'not-a-token' }])
    }
  })

  test('reserved dunder family and poison keys block', () => {
    for (const bad of ['__repo_path__', '__clarify_response__', '__proto__', '__anything__']) {
      expect(agentLaunchBlockers([port(bad)])).toEqual([
        { kind: 'invalid-port-name', port: bad, reason: 'reserved-name' },
      ])
    }
    for (const bad of ['constructor', 'prototype']) {
      expect(agentLaunchBlockers([port(bad)])).toEqual([
        { kind: 'invalid-port-name', port: bad, reason: 'reserved-name' },
      ])
    }
  })

  test('clean ports produce zero blockers; blockers surface in the form', () => {
    expect(agentLaunchBlockers([port('goal'), port('ref', 'path<md>')])).toEqual([])
    const form = deriveAgentLaunchForm([port('go', 'signal')])!
    expect(form.blockers).toEqual([{ kind: 'signal-port', port: 'go' }])
  })
})

describe('wire cap (design P2-4)', () => {
  test('StartAgentTaskSchema caps each port value at AGENT_LAUNCH_INPUT_MAX_LEN', async () => {
    const { StartAgentTaskSchema } = await import('../src/schemas/task')
    const ok = StartAgentTaskSchema.safeParse({
      name: 't',
      inputs: { a: 'x'.repeat(AGENT_LAUNCH_INPUT_MAX_LEN) },
    })
    expect(ok.success).toBe(true)
    const over = StartAgentTaskSchema.safeParse({
      name: 't',
      inputs: { a: 'x'.repeat(AGENT_LAUNCH_INPUT_MAX_LEN + 1) },
    })
    expect(over.success).toBe(false)
  })
})

describe('required semantics (D5)', () => {
  test('required defaults to true; only explicit false is optional', () => {
    expect(agentPortRequired(port('a'))).toBe(true)
    expect(agentPortRequired(port('a', 'string', { required: true }))).toBe(true)
    expect(agentPortRequired(port('a', 'string', { required: false }))).toBe(false)
  })
})
