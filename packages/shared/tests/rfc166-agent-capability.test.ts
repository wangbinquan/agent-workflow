// RFC-166 — agent capability layer schema + capability-card render locks.
//
// Locks the contract:
//  1. AgentInputPortSchema: name required (1..128), kind defaults 'string' and
//     reuses the registered-kind grammar, required/description optional.
//  2. AgentSchema.inputs + CreateAgentSchema.inputs are OPTIONAL (RFC-060
//     precedent): pre-RFC-166 fixtures without `inputs` still parse.
//  3. renderAgentCapabilityCard emits name/description/role/inputs/outputs and
//     a prompt summary clipped by promptBudget; promptBudget:0 omits prompt.
//  4. Prompt-isolation (RFC-099): the card NEVER contains an owner user id even
//     when the source object carries one (the Pick<> surface excludes it, and
//     this test double-locks at the render layer).
//  5. renderRosterCapabilityCards joins cards and honors rosterBudget by
//     dropping the tail with a note.

import { describe, expect, test } from 'bun:test'
import {
  AgentInputPortSchema,
  AgentInputPortsSchema,
  AgentSchema,
  capabilityCardModel,
  clipInputDescription,
  type CapabilitySource,
  CreateAgentSchema,
  perCardInputDescriptionBudget,
  renderAgentCapabilityCard,
  renderRosterCapabilityCards,
} from '../src'

describe('AgentInputPortSchema', () => {
  test('accepts a minimal port, kind defaults to string', () => {
    expect(AgentInputPortSchema.parse({ name: 'diff' })).toEqual({
      name: 'diff',
      kind: 'string',
    })
  })

  test('accepts registered kinds (path<md>, list<string>, signal)', () => {
    expect(AgentInputPortSchema.parse({ name: 'doc', kind: 'path<md>' }).kind).toBe('path<md>')
    expect(AgentInputPortSchema.parse({ name: 'docs', kind: 'list<string>' }).kind).toBe(
      'list<string>',
    )
    expect(AgentInputPortSchema.parse({ name: 'go', kind: 'signal' }).kind).toBe('signal')
  })

  test('carries required + description when present', () => {
    const parsed = AgentInputPortSchema.parse({
      name: 'spec',
      kind: 'markdown',
      required: true,
      description: 'the design doc to audit',
    })
    expect(parsed).toEqual({
      name: 'spec',
      kind: 'markdown',
      required: true,
      description: 'the design doc to audit',
    })
  })

  test('rejects empty name', () => {
    expect(() => AgentInputPortSchema.parse({ name: '' })).toThrow()
  })

  test('rejects an unregistered kind', () => {
    expect(() => AgentInputPortSchema.parse({ name: 'x', kind: 'foo' })).toThrow()
  })

  test('rejects an over-long name (>128)', () => {
    expect(() => AgentInputPortSchema.parse({ name: 'a'.repeat(129) })).toThrow()
  })
})

describe('AgentInputPortsSchema — name uniqueness (Codex PR-1 P2)', () => {
  test('accepts distinct port names', () => {
    expect(
      AgentInputPortsSchema.parse([{ name: 'diff' }, { name: 'spec', kind: 'markdown' }]),
    ).toEqual([
      { name: 'diff', kind: 'string' },
      { name: 'spec', kind: 'markdown' },
    ])
  })

  test('rejects duplicate port names (identity key — capability/orchestration)', () => {
    expect(() =>
      AgentInputPortsSchema.parse([{ name: 'spec' }, { name: 'spec', kind: 'markdown' }]),
    ).toThrow()
  })

  test('accepts empty array', () => {
    expect(AgentInputPortsSchema.parse([])).toEqual([])
  })
})

const BASE_AGENT_FIELDS = {
  id: 'agent_01',
  name: 'reporter',
  description: '',
  outputs: ['report'],
  syncOutputsOnIterate: true,
  permission: {},
  skills: [],
  dependsOn: [],
  mcp: [],
  plugins: [],
  frontmatterExtra: {},
  bodyMd: '',
  schemaVersion: 1,
  createdAt: 0,
  updatedAt: 0,
}

describe('AgentSchema / CreateAgentSchema — RFC-166 inputs', () => {
  test('AgentSchema parses without inputs (optional, pre-RFC-166 fixture)', () => {
    const parsed = AgentSchema.parse(BASE_AGENT_FIELDS)
    expect(parsed.inputs).toBeUndefined()
  })

  test('AgentSchema parses declared inputs with kind default', () => {
    const parsed = AgentSchema.parse({
      ...BASE_AGENT_FIELDS,
      inputs: [{ name: 'diff' }, { name: 'spec', kind: 'markdown', required: true }],
    })
    expect(parsed.inputs).toEqual([
      { name: 'diff', kind: 'string' },
      { name: 'spec', kind: 'markdown', required: true },
    ])
  })

  test('CreateAgentSchema parses without inputs (server fills [])', () => {
    const parsed = CreateAgentSchema.parse({ name: 'a' })
    expect(parsed.inputs).toBeUndefined()
  })

  test('CreateAgentSchema parses declared inputs', () => {
    const parsed = CreateAgentSchema.parse({
      name: 'a',
      inputs: [{ name: 'diff', kind: 'string' }],
    })
    expect(parsed.inputs).toEqual([{ name: 'diff', kind: 'string' }])
  })

  test('AgentSchema rejects an input with a bad kind', () => {
    expect(() =>
      AgentSchema.parse({ ...BASE_AGENT_FIELDS, inputs: [{ name: 'x', kind: 'nope' }] }),
    ).toThrow()
  })

  test('AgentSchema rejects duplicate input port names', () => {
    expect(() =>
      AgentSchema.parse({
        ...BASE_AGENT_FIELDS,
        inputs: [{ name: 'spec' }, { name: 'spec', kind: 'markdown' }],
      }),
    ).toThrow()
  })

  test('CreateAgentSchema rejects duplicate input port names', () => {
    expect(() =>
      CreateAgentSchema.parse({ name: 'a', inputs: [{ name: 'diff' }, { name: 'diff' }] }),
    ).toThrow()
  })
})

const AUDITOR: CapabilitySource = {
  name: 'auditor',
  description: 'Reviews a diff and reports findings.',
  inputs: [
    {
      name: 'diff',
      kind: 'string',
      required: true,
      description: '  the source diff to inspect  ',
    },
    { name: 'spec', kind: 'markdown', description: 'the governing specification' },
  ],
  outputs: ['report', 'signal_done'],
  outputKinds: { report: 'markdown', signal_done: 'signal' },
  role: 'normal',
  bodyMd: 'You are a meticulous code auditor. Read the diff and enumerate concrete defects.',
}

describe('renderAgentCapabilityCard', () => {
  test('renders name / description / role / inputs / outputs / prompt', () => {
    const card = renderAgentCapabilityCard(AUDITOR)
    expect(card).toContain('### auditor')
    expect(card).toContain('Reviews a diff and reports findings.')
    expect(card).toContain('- role: normal')
    expect(card).toContain(
      '- inputs: diff (string, required) — the source diff to inspect, spec (markdown) — the governing specification',
    )
    expect(card).toContain('- outputs: report (markdown), signal_done (signal)')
    expect(card).toContain('- prompt: You are a meticulous code auditor.')
  })

  test('output kind defaults to string when not in outputKinds', () => {
    const card = renderAgentCapabilityCard({ ...AUDITOR, outputKinds: undefined })
    expect(card).toContain('- outputs: report (string), signal_done (string)')
  })

  test('empty inputs / outputs render "(none declared)"', () => {
    const card = renderAgentCapabilityCard({
      ...AUDITOR,
      inputs: [],
      outputs: [],
    })
    expect(card).toContain('- inputs: (none declared)')
    expect(card).toContain('- outputs: (none declared)')
  })

  test('missing role renders normal', () => {
    const card = renderAgentCapabilityCard({ ...AUDITOR, role: undefined })
    expect(card).toContain('- role: normal')
  })

  test('promptBudget:0 omits the prompt line entirely', () => {
    const card = renderAgentCapabilityCard(AUDITOR, { promptBudget: 0 })
    expect(card).not.toContain('- prompt:')
  })

  test('inputDescriptionBudget:0 preserves the pre-RFC-194 input-line shape', () => {
    const card = renderAgentCapabilityCard(AUDITOR, { inputDescriptionBudget: 0 })
    expect(card).toContain('- inputs: diff (string, required), spec (markdown)')
    expect(card).not.toContain('the source diff to inspect')
    expect(card).not.toContain('the governing specification')
  })

  test('input-description fragments, including separators, never exceed the card budget', () => {
    const withoutDescriptions = renderAgentCapabilityCard(AUDITOR, { inputDescriptionBudget: 0 })
    const withDescriptions = renderAgentCapabilityCard(AUDITOR, { inputDescriptionBudget: 24 })
    expect(withDescriptions.length - withoutDescriptions.length).toBeLessThanOrEqual(24)
    expect(withDescriptions).toContain(' — ')
  })

  test('long body is clipped to the budget with an ellipsis', () => {
    const longBody = 'word '.repeat(400) // 2000 chars
    const card = renderAgentCapabilityCard({ ...AUDITOR, bodyMd: longBody }, { promptBudget: 80 })
    const promptLine = card.split('\n').find((l) => l.startsWith('- prompt:')) ?? ''
    // "- prompt: " prefix (10) + <=80 budget + ellipsis
    expect(promptLine.length).toBeLessThanOrEqual(10 + 80 + 1)
    expect(promptLine.endsWith('…')).toBe(true)
  })

  test('prompt-isolation: never leaks an owner user id (RFC-099)', () => {
    // Even if a caller force-feeds an object carrying ACL/audit fields, the
    // Pick<> surface excludes them and the render must not echo the id.
    const leaky = {
      ...AUDITOR,
      // deliberately smuggle fields the card must ignore:
      ownerUserId: 'user_SECRET_OWNER',
      visibility: 'private',
    } as unknown as CapabilitySource
    const card = renderAgentCapabilityCard(leaky)
    expect(card).not.toContain('user_SECRET_OWNER')
    expect(card).not.toContain('ownerUserId')
    expect(card).not.toContain('visibility')
  })
})

describe('RFC-194 input-description budget helpers', () => {
  test('clipInputDescription collapses whitespace and reserves room for ellipsis', () => {
    expect(clipInputDescription('  alpha\n beta  ', 20)).toBe('alpha beta')
    expect(clipInputDescription('abcdef', 1)).toBe('…')
    expect(clipInputDescription('abcdef', 4)).toBe('abc…')
    expect(clipInputDescription('abcdef', 0)).toBe('')
  })

  test('perCardInputDescriptionBudget handles empty, single, and 64-card rosters', () => {
    expect(perCardInputDescriptionBudget(2_400, 0, 240)).toBe(0)
    expect(perCardInputDescriptionBudget(2_400, 1, 240)).toBe(240)
    expect(perCardInputDescriptionBudget(2_400, 64, 240)).toBe(37)
    expect(perCardInputDescriptionBudget(4_800, 64, 600)).toBe(75)
    expect(perCardInputDescriptionBudget(1, 64, 600)).toBe(0)
  })

  test('capabilityCardModel trims descriptions and maps blank text to null', () => {
    const model = capabilityCardModel({
      ...AUDITOR,
      inputs: [
        { name: 'a', kind: 'string', description: '  useful  ' },
        { name: 'b', kind: 'string', description: '   ' },
        { name: 'c', kind: 'string' },
      ],
    })
    expect(model.inputs.map((p) => p.description)).toEqual(['useful', null, null])
  })
})

describe('renderRosterCapabilityCards', () => {
  const CODER: CapabilitySource = {
    name: 'coder',
    description: 'Writes code.',
    inputs: [],
    outputs: ['diff'],
    outputKinds: { diff: 'string' },
    role: 'normal',
    bodyMd: 'You implement features.',
  }

  test('joins multiple cards with a blank line', () => {
    const roster = renderRosterCapabilityCards([AUDITOR, CODER], { promptBudget: 0 })
    expect(roster).toContain('### auditor')
    expect(roster).toContain('### coder')
    expect(roster).toContain('\n\n### coder')
  })

  test('rosterBudget drops the tail with a note', () => {
    const oneCardLen = renderAgentCapabilityCard(AUDITOR, { promptBudget: 0 }).length
    // budget big enough for the first card but not the second
    const roster = renderRosterCapabilityCards([AUDITOR, CODER], {
      promptBudget: 0,
      rosterBudget: oneCardLen + 5,
    })
    expect(roster).toContain('### auditor')
    expect(roster).not.toContain('### coder')
    expect(roster).toContain('1 more agent(s) omitted')
  })

  test('empty roster renders empty string', () => {
    expect(renderRosterCapabilityCards([])).toBe('')
  })
})
