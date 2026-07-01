// RFC-060 PR-B — Agent role + outputWrapperPortNames + signal output kind
// schema-layer locks.
//
// Locks the contract:
//  1. AgentRoleSchema accepts 'normal' / 'aggregator'; rejects others.
//  2. AgentSchema.role is optional — pre-RFC-060 fixtures without `role`
//     still parse; consumers treat undefined as 'normal'.
//  3. AgentSchema.outputWrapperPortNames is optional record of non-empty
//     strings.
//  4. AgentOutputKindsMapSchema accepts 'signal' (PR-B base allowlist).
//  5. CreateAgentSchema mirrors AgentSchema in defaults/optionality.

import { describe, expect, test } from 'bun:test'
import {
  AGENT_ROLE,
  AgentOutputKindsMapSchema,
  AgentOutputWrapperPortNamesSchema,
  AgentRoleSchema,
  AgentSchema,
  CreateAgentSchema,
} from '../src/schemas/agent'

describe('AgentRoleSchema', () => {
  test('AGENT_ROLE enum lists normal + aggregator', () => {
    expect(AGENT_ROLE).toEqual(['normal', 'aggregator'])
  })

  test("accepts 'normal'", () => {
    expect(AgentRoleSchema.parse('normal')).toBe('normal')
  })

  test("accepts 'aggregator'", () => {
    expect(AgentRoleSchema.parse('aggregator')).toBe('aggregator')
  })

  test("rejects unknown role 'supervisor'", () => {
    expect(() => AgentRoleSchema.parse('supervisor')).toThrow()
  })

  test('rejects empty string', () => {
    expect(() => AgentRoleSchema.parse('')).toThrow()
  })
})

describe('AgentOutputWrapperPortNamesSchema', () => {
  test('accepts mapping of port → wrapper port name', () => {
    expect(
      AgentOutputWrapperPortNamesSchema.parse({ report: 'final', summary: 'summary' }),
    ).toEqual({ report: 'final', summary: 'summary' })
  })

  test('rejects empty wrapper name', () => {
    expect(() => AgentOutputWrapperPortNamesSchema.parse({ report: '' })).toThrow()
  })

  test('accepts empty map', () => {
    expect(AgentOutputWrapperPortNamesSchema.parse({})).toEqual({})
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

describe('AgentSchema — RFC-060 fields', () => {
  test('parses without role (defaults to undefined)', () => {
    const parsed = AgentSchema.parse(BASE_AGENT_FIELDS)
    expect(parsed.role).toBeUndefined()
  })

  test("parses with role: 'aggregator'", () => {
    const parsed = AgentSchema.parse({ ...BASE_AGENT_FIELDS, role: 'aggregator' })
    expect(parsed.role).toBe('aggregator')
  })

  test('rejects unknown role', () => {
    expect(() => AgentSchema.parse({ ...BASE_AGENT_FIELDS, role: 'supervisor' })).toThrow()
  })

  test('parses with outputWrapperPortNames', () => {
    const parsed = AgentSchema.parse({
      ...BASE_AGENT_FIELDS,
      role: 'aggregator',
      outputWrapperPortNames: { report: 'final' },
    })
    expect(parsed.outputWrapperPortNames).toEqual({ report: 'final' })
  })
})

describe('CreateAgentSchema — RFC-060 fields', () => {
  test('parses without role (defaults to undefined)', () => {
    const parsed = CreateAgentSchema.parse({ name: 'a' })
    expect(parsed.role).toBeUndefined()
  })

  test("parses with role: 'aggregator'", () => {
    const parsed = CreateAgentSchema.parse({ name: 'a', role: 'aggregator' })
    expect(parsed.role).toBe('aggregator')
  })

  test('parses with outputWrapperPortNames map', () => {
    const parsed = CreateAgentSchema.parse({
      name: 'a',
      outputs: ['report'],
      role: 'aggregator',
      outputWrapperPortNames: { report: 'final' },
    })
    expect(parsed.outputWrapperPortNames).toEqual({ report: 'final' })
  })
})

describe('AgentOutputKindsMap — signal in PR-B', () => {
  test("'signal' accepted as port kind", () => {
    expect(AgentOutputKindsMapSchema.parse({ done: 'signal' })).toEqual({ done: 'signal' })
  })

  test("'path<md>' / 'list<string>' accepted alongside legacy literals", () => {
    expect(
      AgentOutputKindsMapSchema.parse({
        doc: 'path<md>',
        docs: 'list<string>',
        legacy: 'markdown_file',
        plain: 'string',
      }),
    ).toEqual({
      doc: 'path<md>',
      docs: 'list<string>',
      legacy: 'markdown_file',
      plain: 'string',
    })
  })

  test("'foo' still rejected (unregistered base)", () => {
    expect(() => AgentOutputKindsMapSchema.parse({ x: 'foo' })).toThrow()
  })
})
