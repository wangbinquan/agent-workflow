// Wrapper boundary validation must match the runtime's scope projection.
//
// loop/git intentionally accept flat external→inner data edges: the scheduler
// projects those edges to the wrapper at the parent scope, then the child scope
// reads the original source. Values leaving a wrapper are different: they must
// be exposed through a declared wrapper outlet so scheduling, reads, freshness,
// and provenance all observe the same atomic boundary.

import type { Agent, WorkflowDefinition, WorkflowEdge, WorkflowNode } from '@agent-workflow/shared'
import { describe, expect, test } from 'bun:test'
import { validateWorkflowDef } from '../src/services/workflow.validator'

function agent(
  name: string,
  outputs: string[] = ['result'],
  outputKinds: Record<string, string> = { result: 'markdown' },
  role?: Agent['role'],
): Agent {
  return {
    id: `agent-${name}`,
    name,
    description: '',
    outputs,
    outputKinds,
    role,
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

const agents = [
  agent('source', ['result', 'items'], { result: 'markdown', items: 'list<markdown>' }),
  agent('inner'),
  agent('sink'),
  agent('aggregator', ['summary'], { summary: 'markdown' }, 'aggregator'),
]
const context = { agents, skills: [] }

function node(id: string, agentName = id): WorkflowNode {
  return {
    id,
    kind: 'agent-single',
    agentId: `agent-${agentName}`,
    agentName,
  } as WorkflowNode
}

function edge(
  id: string,
  sourceNodeId: string,
  sourcePort: string,
  targetNodeId: string,
  targetPort: string,
): WorkflowEdge {
  return {
    id,
    source: { nodeId: sourceNodeId, portName: sourcePort },
    target: { nodeId: targetNodeId, portName: targetPort },
  }
}

function definition(nodes: WorkflowNode[], edges: WorkflowEdge[] = []): WorkflowDefinition {
  return {
    $schema_version: 4,
    inputs: [],
    nodes,
    edges,
  }
}

function codes(def: WorkflowDefinition): string[] {
  return validateWorkflowDef(def, context).issues.map((issue) => issue.code)
}

describe('workflow wrapper boundary validation', () => {
  test('wrapper containment must be a tree with real, unique direct children', () => {
    const result = codes(
      definition([
        node('inner'),
        {
          id: 'git-a',
          kind: 'wrapper-git',
          nodeIds: ['inner', 'inner', 'missing'],
        } as WorkflowNode,
        {
          id: 'git-b',
          kind: 'wrapper-git',
          nodeIds: ['inner'],
        } as WorkflowNode,
      ]),
    )

    expect(result).toContain('wrapper-child-duplicate')
    expect(result).toContain('wrapper-child-node-missing')
    expect(result).toContain('wrapper-child-multiple-parents')
  })

  test('wrapper containment cycles, including self-containment, are rejected', () => {
    const mutual = codes(
      definition([
        { id: 'git-a', kind: 'wrapper-git', nodeIds: ['git-b'] } as WorkflowNode,
        { id: 'git-b', kind: 'wrapper-git', nodeIds: ['git-a'] } as WorkflowNode,
      ]),
    )
    const self = codes(
      definition([{ id: 'git', kind: 'wrapper-git', nodeIds: ['git'] } as WorkflowNode]),
    )

    expect(mutual).toContain('wrapper-containment-cycle')
    expect(self).toContain('wrapper-containment-cycle')
  })

  test.each([
    {
      kind: 'wrapper-loop',
      wrapper: {
        id: 'wrapper',
        kind: 'wrapper-loop',
        nodeIds: ['inner'],
        maxIterations: 2,
        exitCondition: { kind: 'port-empty', nodeId: 'inner', portName: 'result' },
      } as WorkflowNode,
    },
    {
      kind: 'wrapper-git',
      wrapper: {
        id: 'wrapper',
        kind: 'wrapper-git',
        nodeIds: ['inner'],
      } as WorkflowNode,
    },
  ])('$kind keeps flat external→inner edges legal', ({ wrapper }) => {
    const result = codes(
      definition(
        [node('source'), node('inner'), wrapper],
        [edge('external-in', 'source', 'result', 'inner', 'request')],
      ),
    )

    expect(result).not.toContain('wrapper-input-boundary-missing')
    expect(result).not.toContain('wrapper-output-boundary-missing')
  })

  test('loop inner output may leave only through a matching outputBinding', () => {
    const nodes = [
      node('inner'),
      node('sink'),
      {
        id: 'loop',
        kind: 'wrapper-loop',
        nodeIds: ['inner'],
        maxIterations: 2,
        exitCondition: { kind: 'port-empty', nodeId: 'inner', portName: 'result' },
      } as WorkflowNode,
    ]
    const outgoing = [edge('out', 'inner', 'result', 'sink', 'request')]

    expect(codes(definition(nodes, outgoing))).toContain('wrapper-output-boundary-missing')

    const exposed = nodes.map((candidate) =>
      candidate.id === 'loop'
        ? ({
            ...candidate,
            outputBindings: [{ name: 'final', bind: { nodeId: 'inner', portName: 'result' } }],
          } as WorkflowNode)
        : candidate,
    )
    expect(codes(definition(exposed, outgoing))).not.toContain('wrapper-output-boundary-missing')
  })

  test('git inner output cannot bypass the wrapper git_diff contract', () => {
    expect(
      codes(
        definition(
          [
            node('inner'),
            node('sink'),
            { id: 'git', kind: 'wrapper-git', nodeIds: ['inner'] } as WorkflowNode,
          ],
          [edge('out', 'inner', 'result', 'sink', 'request')],
        ),
      ),
    ).toContain('wrapper-output-boundary-missing')
  })

  test('loop implicit references must stay inside the loop body', () => {
    const result = codes(
      definition([
        node('source'),
        node('inner'),
        {
          id: 'loop',
          kind: 'wrapper-loop',
          nodeIds: ['inner'],
          maxIterations: 2,
          exitCondition: { kind: 'port-empty', nodeId: 'source', portName: 'result' },
          outputBindings: [{ name: 'leak', bind: { nodeId: 'source', portName: 'result' } }],
        } as WorkflowNode,
      ]),
    )

    expect(result).toContain('wrapper-loop-exit-node-out-of-scope')
    expect(result).toContain('wrapper-loop-output-binding-out-of-scope')
  })

  test('output and review implicit bindings cannot read an unexposed git inner row', () => {
    const result = codes(
      definition([
        node('inner'),
        { id: 'git', kind: 'wrapper-git', nodeIds: ['inner'] } as WorkflowNode,
        {
          id: 'publish',
          kind: 'output',
          ports: [{ name: 'artifact', bind: { nodeId: 'inner', portName: 'result' } }],
        } as WorkflowNode,
        {
          id: 'review',
          kind: 'review',
          inputSource: { nodeId: 'inner', portName: 'result' },
          rerunnableOnReject: [],
          rerunnableOnIterate: [],
        } as WorkflowNode,
      ]),
    )

    expect(result.filter((code) => code === 'wrapper-output-boundary-missing')).toHaveLength(2)
  })

  test('fanout keeps its explicit input boundary mandatory', () => {
    const result = codes(
      definition(
        [
          node('source'),
          node('inner'),
          {
            id: 'fan',
            kind: 'wrapper-fanout',
            nodeIds: ['inner'],
            inputs: [{ name: 'items', kind: 'list<markdown>', isShardSource: true }],
          } as WorkflowNode,
        ],
        [edge('bypass', 'source', 'items', 'inner', 'item')],
      ),
    )

    expect(result).toContain('wrapper-input-boundary-missing')
  })

  test('fanout cannot feed itself from a transitively nested descendant', () => {
    const result = codes(
      definition(
        [
          node('inner'),
          {
            id: 'loop',
            kind: 'wrapper-loop',
            nodeIds: ['inner'],
            maxIterations: 2,
            exitCondition: { kind: 'port-empty', nodeId: 'inner', portName: 'result' },
            outputBindings: [{ name: 'final', bind: { nodeId: 'inner', portName: 'result' } }],
          } as WorkflowNode,
          {
            id: 'fan',
            kind: 'wrapper-fanout',
            nodeIds: ['loop'],
            inputs: [{ name: 'items', kind: 'list<markdown>', isShardSource: true }],
          } as WorkflowNode,
        ],
        [edge('nested-bypass', 'inner', 'result', 'fan', 'items')],
      ),
    )

    expect(result).toContain('wrapper-output-boundary-missing')
  })
})
