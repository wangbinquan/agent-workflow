// RFC-023 — clarify validator rules. Maps directly to design.md §2.3 + plan.md T5.

import type { Agent, WorkflowDefinition } from '@agent-workflow/shared'
import { describe, expect, test } from 'bun:test'

import { buildClarifyEdges } from '@agent-workflow/shared'
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
    $schema_version: 3,
    inputs: [],
    nodes: [],
    edges: [],
    ...parts,
  }
}

const designer = agent('designer', ['design'])

describe('RFC-023 clarify validator rules', () => {
  test('happy path: agent-single → clarify produces only the no-loop-cap + answers-disconnected warnings', () => {
    const def = makeDef({
      nodes: [
        { id: 'a1', kind: 'agent-single', agentName: 'designer' },
        { id: 'c1', kind: 'clarify' },
      ],
      edges: buildClarifyEdges('a1', 'c1'),
    })
    const res = validateWorkflowDef(def, { agents: [designer], skills: [] })
    const codes = res.issues.map((i) => i.code)
    // No-loop-cap warning fires (clarify isn't inside a wrapper-loop).
    expect(codes).toContain('clarify-no-iteration-cap')
    // Two-edge cycle means answers ARE connected — no disconnected warning.
    expect(codes).not.toContain('clarify-answers-port-disconnected')
    expect(codes).not.toContain('clarify-target-not-agent')
    // Both warnings should not be errors — overall ok=true.
    expect(res.ok).toBe(true)
  })

  // RFC-060 PR-E: agent-multi removed. Pre-RFC-060 this test asserted that
  // 'agent-multi → clarify' was allowed; the equivalent today is "place the
  // agent-single inside a wrapper-fanout and wire its clarify channel" —
  // covered elsewhere in PR-D's wrapper-fanout test suite.

  test('non-agent upstream (wrapper-git) → clarify is rejected', () => {
    const def = makeDef({
      nodes: [
        { id: 'g1', kind: 'wrapper-git', nodeIds: [] },
        { id: 'c1', kind: 'clarify' },
      ],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'g1', portName: '__clarify__' },
          target: { nodeId: 'c1', portName: 'questions' },
        },
      ],
    })
    const codes = validateWorkflowDef(def, { agents: [designer], skills: [] }).issues.map(
      (i) => i.code,
    )
    expect(codes).toContain('clarify-target-not-agent')
  })

  test('clarify with no inbound edge raises clarify-questions-port-missing', () => {
    const def = makeDef({
      nodes: [{ id: 'c1', kind: 'clarify' }],
    })
    const codes = validateWorkflowDef(def, { agents: [], skills: [] }).issues.map((i) => i.code)
    expect(codes).toContain('clarify-questions-port-missing')
  })

  test('clarify.answers self-loop is rejected', () => {
    const def = makeDef({
      nodes: [
        { id: 'a1', kind: 'agent-single', agentName: 'designer' },
        { id: 'c1', kind: 'clarify' },
      ],
      edges: [
        ...buildClarifyEdges('a1', 'c1'),
        {
          id: 'e_self',
          source: { nodeId: 'c1', portName: 'answers' },
          target: { nodeId: 'c1', portName: 'questions' },
        },
      ],
    })
    const codes = validateWorkflowDef(def, { agents: [designer], skills: [] }).issues.map(
      (i) => i.code,
    )
    expect(codes).toContain('clarify-self-loop')
  })

  test('two clarify nodes attached to the same agent is rejected', () => {
    const def = makeDef({
      nodes: [
        { id: 'a1', kind: 'agent-single', agentName: 'designer' },
        { id: 'c1', kind: 'clarify' },
        { id: 'c2', kind: 'clarify' },
      ],
      edges: [
        // first clarify cycle
        ...buildClarifyEdges('a1', 'c1'),
        // second clarify trying to attach to the same agent
        ...buildClarifyEdges('a1', 'c2'),
      ],
    })
    const codes = validateWorkflowDef(def, { agents: [designer], skills: [] }).issues.map(
      (i) => i.code,
    )
    expect(codes).toContain('clarify-multiple-clarify-on-same-agent')
  })

  test('clarify inside a wrapper-loop suppresses the no-cap warning', () => {
    const def = makeDef({
      nodes: [
        { id: 'a1', kind: 'agent-single', agentName: 'designer' },
        { id: 'c1', kind: 'clarify' },
        {
          id: 'loop1',
          kind: 'wrapper-loop',
          nodeIds: ['a1', 'c1'],
          maxIterations: 5,
          exitCondition: {
            kind: 'port-empty',
            nodeId: 'a1',
            portName: '__clarify__',
          },
          outputBindings: [],
        },
      ],
      edges: buildClarifyEdges('a1', 'c1'),
    })
    const codes = validateWorkflowDef(def, { agents: [designer], skills: [] }).issues.map(
      (i) => i.code,
    )
    expect(codes).not.toContain('clarify-no-iteration-cap')
  })

  test('clarify.answers without outbound edges yields a disconnected warning', () => {
    const edges = buildClarifyEdges('a1', 'c1')
    const questionsEdge = edges[0]!
    const def = makeDef({
      nodes: [
        { id: 'a1', kind: 'agent-single', agentName: 'designer' },
        { id: 'c1', kind: 'clarify' },
      ],
      edges: [questionsEdge], // only the agent→clarify direction
    })
    const codes = validateWorkflowDef(def, { agents: [designer], skills: [] }).issues.map(
      (i) => i.code,
    )
    expect(codes).toContain('clarify-answers-port-disconnected')
  })

  // RFC-063 G1: dedup-by-NodeId; same agent on two edges is one agent.
  test('one clarify with duplicate __clarify__ edges from same agent is allowed (G1 dedup)', () => {
    const def = makeDef({
      nodes: [
        { id: 'a1', kind: 'agent-single', agentName: 'designer' },
        { id: 'c1', kind: 'clarify' },
      ],
      edges: [
        // Two separate edge IDs but both source the SAME agent's __clarify__
        // into c1.questions — dedup keeps agentSourceIds at size 1.
        {
          id: 'e_dup_1',
          source: { nodeId: 'a1', portName: '__clarify__' },
          target: { nodeId: 'c1', portName: 'questions' },
        },
        {
          id: 'e_dup_2',
          source: { nodeId: 'a1', portName: '__clarify__' },
          target: { nodeId: 'c1', portName: 'questions' },
        },
        // Closing the answers loop so we don't trip the disconnected warning.
        {
          id: 'e_answers',
          source: { nodeId: 'c1', portName: 'answers' },
          target: { nodeId: 'a1', portName: '__clarify_response__' },
        },
      ],
    })
    const codes = validateWorkflowDef(def, { agents: [designer], skills: [] }).issues.map(
      (i) => i.code,
    )
    expect(codes).not.toContain('clarify-multiple-source-agents')
  })

  // RFC-063 G1: two distinct agents on one clarify node is rejected.
  test('one clarify attached to two different agents is rejected (G1)', () => {
    const second = agent('reviewer', ['review'])
    const def = makeDef({
      nodes: [
        { id: 'a1', kind: 'agent-single', agentName: 'designer' },
        { id: 'a2', kind: 'agent-single', agentName: 'reviewer' },
        { id: 'c1', kind: 'clarify' },
      ],
      edges: [
        {
          id: 'e_a1',
          source: { nodeId: 'a1', portName: '__clarify__' },
          target: { nodeId: 'c1', portName: 'questions' },
        },
        {
          id: 'e_a2',
          source: { nodeId: 'a2', portName: '__clarify__' },
          target: { nodeId: 'c1', portName: 'questions' },
        },
      ],
    })
    const result = validateWorkflowDef(def, { agents: [designer, second], skills: [] })
    const codes = result.issues.map((i) => i.code)
    expect(codes).toContain('clarify-multiple-source-agents')
    const issue = result.issues.find((i) => i.code === 'clarify-multiple-source-agents')!
    expect(issue.message).toContain('a1')
    expect(issue.message).toContain('a2')
    expect(issue.pointer).toBe('c1')
    expect(result.ok).toBe(false)
  })
})

describe('RFC-023 clarify-target-validator regression guard', () => {
  // C5: ensure agent-single AND agent-multi pass, but every non-agent kind fails.
  // Renaming or accidentally narrowing the validator predicate must trip this.
  const nonAgentKinds = [
    'input',
    'output',
    'wrapper-git',
    'wrapper-loop',
    'review',
    'clarify',
  ] as const
  for (const kind of nonAgentKinds) {
    test(`source kind '${kind}' is rejected with clarify-target-not-agent`, () => {
      const def = makeDef({
        nodes: [
          { id: 's1', kind, agentName: 'x', nodeIds: [], inputKey: 'k', ports: [] },
          { id: 'c1', kind: 'clarify' },
        ],
        edges: [
          {
            id: 'e1',
            source: { nodeId: 's1', portName: '__clarify__' },
            target: { nodeId: 'c1', portName: 'questions' },
          },
        ],
      })
      const codes = validateWorkflowDef(def, { agents: [designer], skills: [] }).issues.map(
        (i) => i.code,
      )
      expect(codes).toContain('clarify-target-not-agent')
    })
  }
})
