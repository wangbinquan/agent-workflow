// RFC-060 PR-B — aggregator-agent-outside-fanout validator rule.
//
// Locks the placeholder behavior: until PR-C introduces wrapper-fanout
// NodeKind, ANY agent-single / agent-multi node referencing an agent with
// role='aggregator' is rejected with `aggregator-agent-outside-fanout`.
// PR-C will refine this rule to "must be an inner node of a
// wrapper-fanout"; the source-text grep in PR-C anchors against
// `aggregator-agent-outside-fanout` to keep the symbol stable.

import type { Agent, Skill, WorkflowDefinition } from '@agent-workflow/shared'
import { describe, expect, test } from 'bun:test'
import { validateWorkflowDef } from '../src/services/workflow.validator'

function agent(name: string, role: Agent['role'] = undefined): Agent {
  const a: Agent = {
    id: `agent-${name}`,
    name,
    description: '',
    outputs: ['out'],
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
  if (role !== undefined) a.role = role
  return a
}

const EMPTY_SKILLS: Skill[] = []

function makeDef(parts: Partial<WorkflowDefinition>): WorkflowDefinition {
  return {
    $schema_version: 1,
    inputs: [],
    nodes: [],
    edges: [],
    ...parts,
  }
}

describe('aggregator-agent-outside-fanout — PR-B placement guard', () => {
  test('normal agent on agent-single node → no aggregator violation', () => {
    const normalAgent = agent('reporter') // role undefined → 'normal'
    const def = makeDef({
      nodes: [{ id: 'n1', kind: 'agent-single', agentName: 'reporter' }],
    })
    const codes = validateWorkflowDef(def, {
      agents: [normalAgent],
      skills: EMPTY_SKILLS,
    }).issues.map((i) => i.code)
    expect(codes).not.toContain('aggregator-agent-outside-fanout')
  })

  test('explicit role: normal agent → no violation', () => {
    const normalAgent = agent('reporter', 'normal')
    const def = makeDef({
      nodes: [{ id: 'n1', kind: 'agent-single', agentName: 'reporter' }],
    })
    const codes = validateWorkflowDef(def, {
      agents: [normalAgent],
      skills: EMPTY_SKILLS,
    }).issues.map((i) => i.code)
    expect(codes).not.toContain('aggregator-agent-outside-fanout')
  })

  test('aggregator agent on agent-single node → flagged', () => {
    const aggregator = agent('merger', 'aggregator')
    const def = makeDef({
      nodes: [{ id: 'n1', kind: 'agent-single', agentName: 'merger' }],
    })
    const issues = validateWorkflowDef(def, {
      agents: [aggregator],
      skills: EMPTY_SKILLS,
    }).issues
    const aggIssue = issues.find((i) => i.code === 'aggregator-agent-outside-fanout')
    expect(aggIssue).not.toBeUndefined()
    expect(aggIssue?.message).toContain("'merger'")
    expect(aggIssue?.message).toContain('wrapper-fanout')
    expect(aggIssue?.pointer).toBe('n1')
  })

  // RFC-060 PR-E: agent-multi was removed, so the prior "aggregator on
  // agent-multi node also flagged" case no longer applies — there is no
  // agent-multi NodeKind to place an aggregator on. The PR-C aggregator-
  // outside-fanout rule still fires for any agent-single placement outside
  // a wrapper-fanout (covered by the test above).

  test('missing agent referenced by node → only agent-not-found, no aggregator check', () => {
    const def = makeDef({
      nodes: [{ id: 'n1', kind: 'agent-single', agentName: 'missing' }],
    })
    const codes = validateWorkflowDef(def, { agents: [], skills: EMPTY_SKILLS }).issues.map(
      (i) => i.code,
    )
    expect(codes).toContain('agent-not-found')
    expect(codes).not.toContain('aggregator-agent-outside-fanout')
  })
})
