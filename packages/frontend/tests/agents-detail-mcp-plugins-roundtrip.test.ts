// Regression: opening an agent's edit page must preserve mcp[] and plugins[].
// Bug: agentToDraft in routes/agents.detail.tsx hard-coded `mcp: []` and
// `plugins: []` when hydrating the form draft. The McpsPicker / PluginsPicker
// therefore rendered empty even though the saved row had entries; the user
// then clicked Save (which PUTs the whole draft) and the previously saved
// MCP / plugin lists were silently overwritten with `[]`. Locks the round-trip
// so the picker shows what's actually on disk.

import { describe, expect, test } from 'vitest'
import type { Agent } from '@agent-workflow/shared'
import { agentToDraft } from '../src/routes/agents.detail'

describe('agentToDraft mcp + plugins round-trip', () => {
  test('preserves mcp[] and plugins[] from the loaded Agent', () => {
    const agent: Agent = {
      id: 'a1',
      name: 'demo',
      description: 'd',
      outputs: [],
      readonly: false,
      syncOutputsOnIterate: true,
      permission: {},
      skills: ['skill-a'],
      dependsOn: ['dep-b'],
      mcp: ['mcp-x', 'mcp-y'],
      plugins: ['plug-1'],
      frontmatterExtra: {},
      bodyMd: '',
      schemaVersion: 1,
      createdAt: 0,
      updatedAt: 0,
    }

    const draft = agentToDraft(agent)

    expect(draft.mcp).toEqual(['mcp-x', 'mcp-y'])
    expect(draft.plugins).toEqual(['plug-1'])
    // Sanity: the previously-fixed neighbours still round-trip too, so any
    // refactor that drops them red-lines this test.
    expect(draft.skills).toEqual(['skill-a'])
    expect(draft.dependsOn).toEqual(['dep-b'])
  })
})
