// RFC-276 compatibility lock for the removed RFC-252 agent network posture.
// New API/package input must reject it, while a legacy agent.md gets an
// explicit warning and never re-emits the obsolete field.

import { describe, expect, test } from 'bun:test'
import {
  CreateAgentSchema,
  parseAgentMarkdown,
  serializeAgentMarkdown,
} from '@agent-workflow/shared'

const basePayload = {
  name: 'agent-a',
  description: '',
  outputs: [],
  syncOutputsOnIterate: true,
  permission: {},
  skills: [],
  dependsOn: [],
  mcp: [],
  plugins: [],
  frontmatterExtra: {},
  bodyMd: '',
}

describe('RFC-276 · removed agent network field', () => {
  test('new structured input rejects the removed field', () => {
    const parsed = CreateAgentSchema.safeParse({ ...basePayload, network: 'deny' })
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.path[0] === 'network')).toBe(true)
    }
  })

  test('legacy agent.md reports and drops the removed field', () => {
    const parsed = parseAgentMarkdown('---\nname: x\nnetwork: deny\n---\n\nbody\n')
    expect(parsed.warnings).toContain('network has been removed and was ignored')
    expect(Object.hasOwn(parsed.partial, 'network')).toBe(false)
    expect(parsed.partial.frontmatterExtra).not.toHaveProperty('network')
  })

  test('serializer never revives network from legacy frontmatterExtra', () => {
    const serialized = serializeAgentMarkdown({
      name: 'x',
      bodyMd: 'body',
      frontmatterExtra: { network: 'allow', retained: 'yes' },
    })
    expect(serialized).not.toContain('network:')
    expect(serialized).toContain('retained: yes')
  })
})
