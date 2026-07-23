import { describe, expect, test } from 'vitest'
import type { Agent, WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import {
  createWorkflowSemanticContext,
  planWorkflowEdgeInsertion,
} from '../src/lib/workflow-connection-plan'
import { applyWorkflowTransition } from '../src/lib/workflow-transition'

function agentNode(id: string, agentName = id, x = 0): WorkflowNode {
  return {
    id,
    kind: 'agent-single',
    agentId: `agent-${agentName}`,
    agentName,
    position: { x, y: 0 },
  } as WorkflowNode
}

const agents = [
  { id: 'agent-a', name: 'a', outputs: ['doc'], outputKinds: { doc: 'markdown' } },
  { id: 'agent-n', name: 'n', outputs: ['out'], outputKinds: { out: 'string' } },
] as unknown as Agent[]

function ordinaryDefinition(): WorkflowDefinition {
  return {
    $schema_version: 4,
    inputs: [],
    nodes: [
      agentNode('a', 'a', 0),
      agentNode('n-placeholder', 'n', 200),
      {
        id: 'b',
        kind: 'output',
        position: { x: 500, y: 0 },
        ports: [{ name: 'existing', bind: { nodeId: 'a', portName: 'doc' } }],
      } as WorkflowNode,
    ],
    edges: [
      {
        id: 'old-edge',
        source: { nodeId: 'a', portName: 'doc' },
        target: { nodeId: 'b', portName: 'existing' },
      },
    ],
  }
}

describe('workflow edge insertion planner', () => {
  test('atomically preserves the old target port and rewrites its mirror once', () => {
    const definition = ordinaryDefinition()
    definition.nodes = definition.nodes.filter((node) => node.id !== 'n-placeholder')
    const context = createWorkflowSemanticContext(agents)
    const inserted = agentNode('n', 'n', 240)
    const plan = planWorkflowEdgeInsertion(definition, 'old-edge', inserted, context)
    expect(plan).toMatchObject({ ok: true, removeEdgeIds: ['old-edge'] })
    if (!plan.ok) throw new Error(plan.reason.message)
    expect(plan.addNodes).toEqual([inserted])

    const result = applyWorkflowTransition(definition, { kind: 'connection', plan }, context)
    expect(result.warnings).toEqual([])
    expect(result.next.edges).toHaveLength(2)
    expect(result.next.edges).toContainEqual(
      expect.objectContaining({
        source: { nodeId: 'a', portName: 'doc' },
        target: { nodeId: 'n', portName: 'doc' },
      }),
    )
    expect(result.next.edges).toContainEqual(
      expect.objectContaining({
        source: { nodeId: 'n', portName: 'out' },
        target: { nodeId: 'b', portName: 'existing' },
      }),
    )
    expect(result.next.edges.some((edge) => edge.id === 'old-edge')).toBe(false)
    const output = result.next.nodes.find((node) => node.id === 'b') as unknown as {
      ports: Array<{ name: string; bind: { nodeId: string; portName: string } }>
    }
    expect(output.ports).toEqual([{ name: 'existing', bind: { nodeId: 'n', portName: 'out' } }])
  })

  test('fails closed for boundary and wrapper-inner edges', () => {
    const context = createWorkflowSemanticContext(agents)
    const boundary = ordinaryDefinition()
    boundary.nodes = boundary.nodes.filter((node) => node.id !== 'n-placeholder')
    boundary.edges[0] = { ...boundary.edges[0]!, boundary: 'wrapper-output' }
    expect(planWorkflowEdgeInsertion(boundary, 'old-edge', agentNode('n', 'n'), context).ok).toBe(
      false,
    )

    const inner = ordinaryDefinition()
    inner.nodes = [
      ...inner.nodes.filter((node) => node.id !== 'n-placeholder'),
      {
        id: 'wrap',
        kind: 'wrapper-git',
        nodeIds: ['a'],
        position: { x: -20, y: -20 },
      } as WorkflowNode,
    ]
    expect(planWorkflowEdgeInsertion(inner, 'old-edge', agentNode('n', 'n'), context).ok).toBe(
      false,
    )
  })
})
