// Regression: opening an agent's edit page must preserve outputKinds.
// Bug: agentToDraft in routes/agents.detail.tsx omitted outputKinds, so every
// reopen reset port kinds to default 'string' — the user's saved markdown /
// markdown_file selection was lost on next page load. Locks the per-port kind
// round-trip on the detail page.

import { describe, expect, test } from 'vitest'
import type { Agent } from '@agent-workflow/shared'
import { agentToDraft } from '../src/routes/agents.detail'

describe('agentToDraft', () => {
  test('preserves outputKinds so reopening the edit page keeps saved kinds', () => {
    const agent: Agent = {
      id: 'a1',
      name: 'demo',
      description: 'd',
      outputs: ['report', 'note'],
      outputKinds: { report: 'markdown_file', note: 'markdown' },
      readonly: false,
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: [],
      frontmatterExtra: {},
      bodyMd: '',
      schemaVersion: 1,
      createdAt: 0,
      updatedAt: 0,
    }

    const draft = agentToDraft(agent)

    expect(draft.outputKinds).toEqual({ report: 'markdown_file', note: 'markdown' })
  })
})
