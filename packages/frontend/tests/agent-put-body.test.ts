// RFC-173 (T5, AC-7) — the save mutation's PUT body must carry skills / mcp /
// plugins / dependsOn through the resource-picker rewrite untouched. The old
// roundtrip test only exercised agentToDraft (GET → form); this locks the
// FORM → PUT direction, which is where a picker bug would actually drop data.

import { describe, expect, test } from 'vitest'
import type { CreateAgent } from '@agent-workflow/shared'
import { agentToPutBody } from '../src/routes/agents.detail'

const base: CreateAgent = {
  name: 'demo',
  description: 'd',
  outputs: [],
  syncOutputsOnIterate: true,
  permission: {},
  skills: [
    { kind: 'managed', skillId: 'skill-a' },
    { kind: 'managed', skillId: 'skill-b' },
  ],
  dependsOn: ['dep-1'],
  mcp: ['mcp-x', 'mcp-y'],
  plugins: ['plug-1'],
  frontmatterExtra: {},
  bodyMd: '',
}

describe('agentToPutBody — wire shape', () => {
  test('preserves the four resource arrays; drops name; inherits → runtime null', () => {
    const body = agentToPutBody(base)
    expect(body.skills).toEqual([
      { kind: 'managed', skillId: 'skill-a' },
      { kind: 'managed', skillId: 'skill-b' },
    ])
    expect(body.mcp).toEqual(['mcp-x', 'mcp-y'])
    expect(body.plugins).toEqual(['plug-1'])
    expect(body.dependsOn).toEqual(['dep-1'])
    expect('name' in body).toBe(false) // name is in the URL, not the body
    expect(body.runtime).toBeNull() // RFC-115: explicit null clears a pin
  })

  test('keeps a pinned runtime', () => {
    const body = agentToPutBody({ ...base, runtime: 'claude-code' })
    expect(body.runtime).toBe('claude-code')
  })
})
