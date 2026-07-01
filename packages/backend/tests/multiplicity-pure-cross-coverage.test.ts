// RFC-069 C2 — pure cross+cross multi-attachment coverage (RFC-064 §7.1 gap).
//
// Pre-RFC-069 the `clarify-multiple-clarify-on-same-agent` rule was physically
// located inside §4c (self-clarify case block) of workflow.validator.ts and
// fired only when the validator visited a self-clarify node. Workflows that
// contained ONLY clarify-cross-agent nodes (no self-clarify) would skip §4c
// entirely and the rule never ran — so an agent attached to ≥ 2 cross-clarify
// nodes silently passed validation; at runtime the framework picked the first
// `__clarify__` edge by enumeration order and delivered the agent's envelope
// only to that target, leaving the others in undefined behavior.
//
// RFC-069 lifts the rule into a NodeKind-agnostic pre-pass that walks all
// edges regardless of target NodeKind, so the pure-cross case now correctly
// fails validation with the existing `clarify-multiple-clarify-on-same-agent`
// error code (no new code introduced — pre-pass message lists the dict-min
// target id; pointer = dict-min target).
//
// These tests lock the new behavior. If the rule ever regresses back into a
// case block, the pure-cross case will silently pass again and these tests
// turn red. DO NOT relax the assertions without first re-reading
// design/RFC-069-multiplicity-validation-prepass/proposal.md §3 S6.

import type { Agent, WorkflowDefinition, WorkflowEdge } from '@agent-workflow/shared'
import { describe, expect, test } from 'bun:test'

import { validateWorkflowDef } from '../src/services/workflow.validator'

function agent(name: string, outputs: string[] = []): Agent {
  return {
    id: `agent-${name}`,
    name,
    description: '',
    outputs,
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

function makeDef(parts: Partial<WorkflowDefinition>): WorkflowDefinition {
  return {
    $schema_version: 4,
    inputs: [],
    nodes: [],
    edges: [],
    ...parts,
  }
}

function buildAutoEdges(questionerId: string, crossId: string): WorkflowEdge[] {
  const base = `e_${questionerId}_${crossId}`
  return [
    {
      id: `${base}_clarify`,
      source: { nodeId: questionerId, portName: '__clarify__' },
      target: { nodeId: crossId, portName: 'questions' },
    },
    {
      id: `${base}_to_questioner`,
      source: { nodeId: crossId, portName: 'to_questioner' },
      target: { nodeId: questionerId, portName: '__clarify_response__' },
    },
  ]
}

function buildManualToDesigner(crossId: string, designerId: string): WorkflowEdge {
  return {
    id: `e_${crossId}_${designerId}_to_designer`,
    source: { nodeId: crossId, portName: 'to_designer' },
    target: { nodeId: designerId, portName: '__external_feedback__' },
  }
}

const designer = agent('designer', ['design'])
const questioner = agent('questioner', ['main'])

describe('RFC-069 C2 — pure cross+cross multi-attachment closes RFC-064 §7.1 gap', () => {
  // C2-1: workflow contains ONLY clarify-cross-agent nodes (no self-clarify);
  // one questioner agent is attached to 2 cross-clarify nodes via `__clarify__`
  // outbound edges. Pre-RFC-069 this silently passed; post-RFC-069 the pre-pass
  // emits `clarify-multiple-clarify-on-same-agent` exactly once.
  test('agent attached to 2 cross-clarify nodes (no self-clarify present) is rejected', () => {
    const def = makeDef({
      nodes: [
        { id: 'd1', kind: 'agent-single', agentName: 'designer' },
        { id: 'q1', kind: 'agent-single', agentName: 'questioner' },
        { id: 'cc1', kind: 'clarify-cross-agent' },
        { id: 'cc2', kind: 'clarify-cross-agent' },
      ],
      edges: [
        {
          id: 'e_d1_q1',
          source: { nodeId: 'd1', portName: 'design' },
          target: { nodeId: 'q1', portName: 'design' },
        },
        // questioner q1 fans `__clarify__` into BOTH cross-clarify nodes.
        ...buildAutoEdges('q1', 'cc1'),
        ...buildAutoEdges('q1', 'cc2'),
        buildManualToDesigner('cc1', 'd1'),
        buildManualToDesigner('cc2', 'd1'),
      ],
    })
    const res = validateWorkflowDef(def, { agents: [designer, questioner], skills: [] })
    const codes = res.issues.map((i) => i.code)
    expect(codes).toContain('clarify-multiple-clarify-on-same-agent')

    // Sanity: no self-clarify nodes exist in this workflow — proves the pre-
    // pass fires without depending on §4c being entered.
    const hasSelfClarifyNode = def.nodes.some((n) => n.kind === 'clarify')
    expect(hasSelfClarifyNode).toBe(false)

    expect(res.ok).toBe(false)
  })

  // C2-2: the emitted message lists the two cross-clarify NodeIds in
  // dictionary order (`cc1` < `cc2`) and the pointer is the dict-min target,
  // matching design.md §2 Rule 1 contract.
  test('message dictionary-min target + pointer match design.md §2 Rule 1 contract', () => {
    const def = makeDef({
      nodes: [
        { id: 'd1', kind: 'agent-single', agentName: 'designer' },
        { id: 'q1', kind: 'agent-single', agentName: 'questioner' },
        { id: 'cc1', kind: 'clarify-cross-agent' },
        { id: 'cc2', kind: 'clarify-cross-agent' },
      ],
      edges: [
        {
          id: 'e_d1_q1',
          source: { nodeId: 'd1', portName: 'design' },
          target: { nodeId: 'q1', portName: 'design' },
        },
        ...buildAutoEdges('q1', 'cc1'),
        ...buildAutoEdges('q1', 'cc2'),
        buildManualToDesigner('cc1', 'd1'),
        buildManualToDesigner('cc2', 'd1'),
      ],
    })
    const res = validateWorkflowDef(def, { agents: [designer, questioner], skills: [] })
    const issue = res.issues.find((i) => i.code === 'clarify-multiple-clarify-on-same-agent')!
    expect(issue).toBeDefined()
    // Exact message template from validator.ts (byte-level preservation of
    // the original §4c template; only the iterated id is replaced by the
    // dictionary-min target id).
    expect(issue.message).toBe(
      `agent 'q1' already has a clarify channel; remove the other clarify node before adding 'cc1'`,
    )
    expect(issue.pointer).toBe('cc1')
  })

  // C2-3: the rule emits exactly ONE issue per agent regardless of how many
  // additional cross-clarify targets exist (design.md §7 边界条件 row 5).
  // Counts ≥ 3 distinct targets must still produce a single, dict-min-pointing
  // issue rather than N-1 issues.
  test('agent attached to 3 cross-clarify nodes still emits exactly one issue', () => {
    const def = makeDef({
      nodes: [
        { id: 'd1', kind: 'agent-single', agentName: 'designer' },
        { id: 'q1', kind: 'agent-single', agentName: 'questioner' },
        { id: 'cc-a', kind: 'clarify-cross-agent' },
        { id: 'cc-b', kind: 'clarify-cross-agent' },
        { id: 'cc-c', kind: 'clarify-cross-agent' },
      ],
      edges: [
        {
          id: 'e_d1_q1',
          source: { nodeId: 'd1', portName: 'design' },
          target: { nodeId: 'q1', portName: 'design' },
        },
        ...buildAutoEdges('q1', 'cc-a'),
        ...buildAutoEdges('q1', 'cc-b'),
        ...buildAutoEdges('q1', 'cc-c'),
        buildManualToDesigner('cc-a', 'd1'),
        buildManualToDesigner('cc-b', 'd1'),
        buildManualToDesigner('cc-c', 'd1'),
      ],
    })
    const res = validateWorkflowDef(def, { agents: [designer, questioner], skills: [] })
    const multiClarifyIssues = res.issues.filter(
      (i) => i.code === 'clarify-multiple-clarify-on-same-agent',
    )
    // ONE issue, not N-1 — pre-pass aggregates by agent, not per target.
    expect(multiClarifyIssues).toHaveLength(1)
    // Pointer = dictionary-min target across the three: 'cc-a' < 'cc-b' < 'cc-c'.
    expect(multiClarifyIssues[0]!.pointer).toBe('cc-a')
    expect(multiClarifyIssues[0]!.message).toContain(`adding 'cc-a'`)
  })
})

describe('RFC-069 — mixed self+cross multi-attachment also covered by pre-pass', () => {
  // Sanity check that the pre-pass also catches the original §4c case
  // (1 self + 1 cross sharing an agent), since the pre-pass collapses both
  // NodeKinds into the same group-by-agent walk. This was already covered
  // by RFC-063 G1 self-only test, but never with a mixed-kind topology.
  test('agent attached to 1 self-clarify + 1 cross-clarify is rejected', () => {
    const def = makeDef({
      nodes: [
        { id: 'd1', kind: 'agent-single', agentName: 'designer' },
        { id: 'q1', kind: 'agent-single', agentName: 'questioner' },
        { id: 'c1', kind: 'clarify' },
        { id: 'cc1', kind: 'clarify-cross-agent' },
      ],
      edges: [
        {
          id: 'e_d1_q1',
          source: { nodeId: 'd1', portName: 'design' },
          target: { nodeId: 'q1', portName: 'design' },
        },
        // q1.__clarify__ → c1.questions
        {
          id: 'e_q1_c1',
          source: { nodeId: 'q1', portName: '__clarify__' },
          target: { nodeId: 'c1', portName: 'questions' },
        },
        // c1.answers → q1.__clarify_response__
        {
          id: 'e_c1_q1',
          source: { nodeId: 'c1', portName: 'answers' },
          target: { nodeId: 'q1', portName: '__clarify_response__' },
        },
        // q1.__clarify__ → cc1.questions (also)
        ...buildAutoEdges('q1', 'cc1'),
        buildManualToDesigner('cc1', 'd1'),
      ],
    })
    const res = validateWorkflowDef(def, { agents: [designer, questioner], skills: [] })
    const codes = res.issues.map((i) => i.code)
    expect(codes).toContain('clarify-multiple-clarify-on-same-agent')

    // Dict-min between 'c1' and 'cc1' is 'c1' (alphabetical, 'c' < 'c' tie
    // broken by length: 'c1' < 'cc1').
    const issue = res.issues.find((i) => i.code === 'clarify-multiple-clarify-on-same-agent')!
    expect(issue.pointer).toBe('c1')
  })
})
