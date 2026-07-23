import type { Agent } from '@agent-workflow/shared'
import { describe, expect, test } from 'bun:test'
import { planWorkflowStarter } from '../../frontend/src/lib/workflow-starters'
import { validateWorkflowDefinition } from '../src/services/workflow.validator'

function agent(
  name: string,
  options: Partial<Pick<Agent, 'outputs' | 'outputKinds' | 'role' | 'outputWrapperPortNames'>> = {},
): Agent {
  return {
    id: `id-${name}`,
    name,
    description: '',
    outputs: options.outputs ?? ['result'],
    outputKinds: options.outputKinds ?? { result: 'markdown' },
    outputWrapperPortNames: options.outputWrapperPortNames,
    role: options.role,
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
}

describe('RFC-199 T11.4 — starter catalog uses the production validator', () => {
  const agents = [
    agent('coder'),
    agent('auditor', { outputs: ['finding'], outputKinds: { finding: 'markdown' } }),
    agent('aggregator', {
      role: 'aggregator',
      outputs: ['summary'],
      outputKinds: { summary: 'markdown' },
      outputWrapperPortNames: { summary: 'audit_summary' },
    }),
    agent('fixer', { outputs: ['patch'], outputKinds: { patch: 'markdown' } }),
  ]

  for (const [starterId, mapping] of [
    [
      'standard-development',
      {
        coder: 'id-coder',
        auditor: 'id-auditor',
        aggregator: 'id-aggregator',
        fixer: 'id-fixer',
      },
    ],
    ['audit-only', { auditor: 'id-auditor' }],
  ] as const) {
    test(`${starterId} remains validator-clean`, () => {
      const planned = planWorkflowStarter(starterId, mapping, agents)
      expect(planned.ok).toBe(true)
      if (!planned.ok) return
      expect(
        validateWorkflowDefinition(planned.definition, { agents, skills: [], plugins: [] }),
      ).toEqual({
        ok: true,
        issues: [],
      })
    })
  }
})
