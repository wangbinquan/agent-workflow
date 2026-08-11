// RFC-276 — OpenCode receives only the agent's explicit permission overlay.

import { describe, expect, test } from 'bun:test'
import type { Agent } from '@agent-workflow/shared'
import { buildInlineAgentEntry, buildInlineConfig } from '../src/services/runtime/opencode/inlineConfig'

function agent(name: string, permission: Record<string, unknown> = {}): Agent {
  return {
    id: `agent-${name}`,
    name,
    description: '',
    outputs: [],
    syncOutputsOnIterate: true,
    permission,
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
}

describe('RFC-276 OpenCode permission overlay', () => {
  test('does not inject a top-level platform permission map', () => {
    const out = buildInlineConfig(agent('a'), new Map(), [], [])
    expect('permission' in out).toBe(false)
  })

  test('preserves every explicit primary-agent rule verbatim', () => {
    const permission = { question: 'allow', bash: 'deny', '*': 'ask' }
    const entry = buildInlineAgentEntry(agent('a', permission))
    expect(entry.permission).toEqual(permission)
  })

  test('preserves every explicit dependent-agent rule verbatim', () => {
    const permission = { question: 'allow', edit: 'deny' }
    const out = buildInlineConfig(agent('root'), new Map(), [agent('dep', permission)], [])
    expect(out.agent.dep?.permission).toEqual(permission)
  })
})
