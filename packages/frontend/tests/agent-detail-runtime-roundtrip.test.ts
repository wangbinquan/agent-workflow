// RFC-115 regression: the agent edit form must echo an agent's PINNED runtime,
// not always show "inherit (global default)". Root cause: agentToDraft (the
// API→form-draft mapper in routes/agents.detail.tsx) copied model / variant /
// temperature / steps / maxSteps but DROPPED `runtime`, so every pinned agent
// mis-rendered as inheriting. The RFC-113 startup migration had pinned every
// user agent, so this affected ALL of them — and also made switching the global
// default runtime look like a no-op (the agents were really pinned, not inheriting).
import { describe, expect, test } from 'vitest'
import type { Agent } from '@agent-workflow/shared'
import { agentToDraft } from '../src/routes/agents.detail'

function agent(over: Partial<Agent>): Agent {
  return {
    id: 'a',
    name: 'a',
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
    schemaVersion: 1,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }
}

describe('agentToDraft — runtime round-trip (RFC-115)', () => {
  test('carries a pinned custom runtime into the draft', () => {
    expect(agentToDraft(agent({ runtime: 'opencode-1' })).runtime).toBe('opencode-1')
  })

  test('carries a pinned built-in runtime into the draft', () => {
    expect(agentToDraft(agent({ runtime: 'opencode' })).runtime).toBe('opencode')
  })

  test('leaves runtime undefined when the agent inherits the global default', () => {
    expect(agentToDraft(agent({})).runtime).toBeUndefined()
  })
})
