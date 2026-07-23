import { describe, expect, test } from 'vitest'
import type { Agent, WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import { planWorkflowLayout, projectWorkflowLayoutDependencies } from '../src/lib/workflow-layout'
import { createWorkflowSemanticContext } from '../src/lib/workflow-connection-plan'

function agent(name: string, outputKinds: Record<string, string> = { out: 'markdown' }): Agent {
  return {
    id: `id-${name}`,
    name,
    description: '',
    outputs: Object.keys(outputKinds),
    outputKinds,
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

function node(id: string, extra: Partial<WorkflowNode> = {}): WorkflowNode {
  return {
    id,
    kind: 'agent-single',
    agentId: `id-${id}`,
    agentName: id,
    position: { x: 0, y: 0 },
    ...extra,
  } as WorkflowNode
}

function definition(nodes: WorkflowNode[], edges: WorkflowDefinition['edges']): WorkflowDefinition {
  return { $schema_version: 4, inputs: [], nodes, edges }
}

const semantic = createWorkflowSemanticContext([
  agent('a', { done: 'signal', out: 'markdown' }),
  agent('b'),
  agent('c'),
  agent('inner'),
  agent('child'),
  agent('sink'),
])

describe('RFC-199 T12 workflow layout planner', () => {
  test('projects data and signal dependencies while excluding boundary/system mirrors', () => {
    const def = definition(
      [
        node('a'),
        node('b'),
        {
          id: 'fan',
          kind: 'wrapper-fanout',
          nodeIds: ['inner'],
          inputs: [{ name: 'items', kind: 'list<string>', isShardSource: true }],
        } as WorkflowNode,
        node('inner'),
      ],
      [
        {
          id: 'signal',
          source: { nodeId: 'a', portName: 'done' },
          target: { nodeId: 'b', portName: 'ready' },
        },
        {
          id: 'boundary',
          source: { nodeId: 'fan', portName: 'items' },
          target: { nodeId: 'inner', portName: 'item' },
          boundary: 'wrapper-input',
        },
        {
          id: 'system',
          source: { nodeId: 'a', portName: '__clarify__' },
          target: { nodeId: 'b', portName: '__clarify_response__' },
        },
      ],
    )
    expect(projectWorkflowLayoutDependencies(def, semantic)).toEqual([
      {
        scopeId: null,
        sourceNodeId: 'a',
        targetNodeId: 'b',
        edgeId: 'signal',
        control: true,
      },
    ])
  })

  test('LCA projection ranks external → wrapper-inner → downstream at top level', () => {
    const def = definition(
      [
        node('a'),
        {
          id: 'wrap',
          kind: 'wrapper-git',
          nodeIds: ['inner'],
          position: { x: 0, y: 0 },
        } as WorkflowNode,
        node('inner'),
        node('sink'),
      ],
      [
        {
          id: 'into-inner',
          source: { nodeId: 'a', portName: 'out' },
          target: { nodeId: 'inner', portName: 'input' },
        },
        {
          id: 'out-of-inner',
          source: { nodeId: 'inner', portName: 'out' },
          target: { nodeId: 'sink', portName: 'input' },
        },
      ],
    )
    const projected = projectWorkflowLayoutDependencies(def, semantic)
    expect(projected.map((edge) => [edge.sourceNodeId, edge.targetNodeId])).toEqual([
      ['a', 'wrap'],
      ['wrap', 'sink'],
    ])
    const { next } = planWorkflowLayout(def, { semanticContext: semantic })
    const positions = new Map(next.nodes.map((candidate) => [candidate.id, candidate.position!]))
    expect(positions.get('a')!.x).toBeLessThan(positions.get('wrap')!.x)
    expect(positions.get('wrap')!.x).toBeLessThan(positions.get('sink')!.x)
  })

  test('cycle back-edge choice and resulting coordinates are stable', () => {
    const def = definition(
      [node('a'), node('b'), node('c')],
      [
        {
          id: 'ab',
          source: { nodeId: 'a', portName: 'out' },
          target: { nodeId: 'b', portName: 'in' },
        },
        {
          id: 'bc',
          source: { nodeId: 'b', portName: 'out' },
          target: { nodeId: 'c', portName: 'in' },
        },
        {
          id: 'ca',
          source: { nodeId: 'c', portName: 'out' },
          target: { nodeId: 'a', portName: 'in' },
        },
      ],
    )
    const first = planWorkflowLayout(def, { semanticContext: semantic })
    const second = planWorkflowLayout(def, { semanticContext: semantic })
    expect(first).toEqual(second)
    expect(first.warnings).toEqual([{ code: 'cycle-back-edge', edgeId: 'ca' }])
  })

  test('uses a detached measured-size snapshot and keeps branch/merge ranks non-overlapping', () => {
    const def = definition(
      [node('a'), node('b'), node('c'), node('sink'), node('inner')],
      [
        {
          id: 'ab',
          source: { nodeId: 'a', portName: 'out' },
          target: { nodeId: 'b', portName: 'in' },
        },
        {
          id: 'ac',
          source: { nodeId: 'a', portName: 'out' },
          target: { nodeId: 'c', portName: 'in' },
        },
        {
          id: 'bs',
          source: { nodeId: 'b', portName: 'out' },
          target: { nodeId: 'sink', portName: 'in' },
        },
        {
          id: 'cs',
          source: { nodeId: 'c', portName: 'out' },
          target: { nodeId: 'sink', portName: 'in' },
        },
      ],
    )
    const measuredA = { width: 520, height: 260 }
    const measured = new Map([['a', measuredA]])
    const { next } = planWorkflowLayout(def, { semanticContext: semantic, measuredSizes: measured })
    const positions = new Map(next.nodes.map((candidate) => [candidate.id, candidate.position!]))
    expect(positions.get('b')!.x).toBeGreaterThanOrEqual(positions.get('a')!.x + measuredA.width)
    expect(positions.get('c')!.x).toBeGreaterThanOrEqual(positions.get('a')!.x + measuredA.width)
    expect(positions.get('sink')!.x).toBeGreaterThan(positions.get('b')!.x)
    expect(positions.get('sink')!.x).toBeGreaterThan(positions.get('c')!.x)
    expect(positions.get('b')!.y).not.toBe(positions.get('c')!.y)
    expect(measuredA).toEqual({ width: 520, height: 260 })
    expect(measured.get('a')).toBe(measuredA)
  })

  test('selection starts at its old bbox anchor and shifts only when needed to avoid untouched nodes', () => {
    const def = definition(
      [
        node('a', { position: { x: 0, y: 0 } }),
        node('b', { position: { x: 20, y: 0 } }),
        node('sink', { position: { x: 320, y: 0 } }),
      ],
      [
        {
          id: 'ab',
          source: { nodeId: 'a', portName: 'out' },
          target: { nodeId: 'b', portName: 'in' },
        },
      ],
    )
    const result = planWorkflowLayout(def, {
      semanticContext: semantic,
      selection: { mode: 'selection', nodeIds: ['a', 'b'] },
    })
    const positions = new Map(
      result.next.nodes.map((candidate) => [candidate.id, candidate.position!]),
    )
    expect(positions.get('sink')).toEqual({ x: 320, y: 0 })
    expect(positions.get('a')!.y).toBeGreaterThan(0)
    expect(positions.get('b')!.y).toBe(positions.get('a')!.y)
    expect(positions.get('b')!.x).toBeGreaterThan(positions.get('a')!.x)
  })

  test('moving a selected wrapper translates its complete descendant closure by one delta', () => {
    const def = definition(
      [
        {
          id: 'outer',
          kind: 'wrapper-git',
          nodeIds: ['inner-wrap'],
          position: { x: 500, y: 200 },
          size: { width: 500, height: 360 },
        } as WorkflowNode,
        {
          id: 'inner-wrap',
          kind: 'wrapper-git',
          nodeIds: ['child'],
          position: { x: 600, y: 300 },
          size: { width: 300, height: 220 },
        } as WorkflowNode,
        node('child', { position: { x: 660, y: 380 } }),
        node('sink', { position: { x: 0, y: 0 } }),
      ],
      [
        {
          id: 'flow',
          source: { nodeId: 'inner-wrap', portName: 'git_diff' },
          target: { nodeId: 'sink', portName: 'files' },
        },
      ],
    )
    const beforeWrapper = def.nodes.find((candidate) => candidate.id === 'outer')!.position!
    const beforeInner = def.nodes.find((candidate) => candidate.id === 'inner-wrap')!.position!
    const beforeChild = def.nodes.find((candidate) => candidate.id === 'child')!.position!
    const result = planWorkflowLayout(def, {
      semanticContext: semantic,
      selection: { mode: 'selection', nodeIds: ['outer', 'sink'] },
    })
    const afterWrapper = result.next.nodes.find((candidate) => candidate.id === 'outer')!.position!
    const afterInner = result.next.nodes.find(
      (candidate) => candidate.id === 'inner-wrap',
    )!.position!
    const afterChild = result.next.nodes.find((candidate) => candidate.id === 'child')!.position!
    expect({ x: afterInner.x - afterWrapper.x, y: afterInner.y - afterWrapper.y }).toEqual({
      x: beforeInner.x - beforeWrapper.x,
      y: beforeInner.y - beforeWrapper.y,
    })
    expect({ x: afterChild.x - afterInner.x, y: afterChild.y - afterInner.y }).toEqual({
      x: beforeChild.x - beforeInner.x,
      y: beforeChild.y - beforeInner.y,
    })
  })

  test('cross-scope selection is advisory and makes no mutation', () => {
    const def = definition(
      [
        { id: 'wrap', kind: 'wrapper-git', nodeIds: ['inner'] } as WorkflowNode,
        node('inner'),
        node('sink'),
      ],
      [],
    )
    const result = planWorkflowLayout(def, {
      semanticContext: semantic,
      selection: { mode: 'selection', nodeIds: ['inner', 'sink'] },
    })
    expect(result.next).toBe(def)
    expect(result.warnings).toEqual([{ code: 'cross-scope-selection', nodeIds: ['inner', 'sink'] }])
  })

  test('sizeLocked preserves the wrapper rectangle and returns a visible overflow warning', () => {
    const def = definition(
      [
        {
          id: 'wrap',
          kind: 'wrapper-git',
          nodeIds: ['a', 'b'],
          position: { x: 100, y: 100 },
          size: { width: 220, height: 140, sizeLocked: true },
        } as WorkflowNode,
        node('a', { position: { x: 140, y: 160 } }),
        node('b', { position: { x: 160, y: 180 } }),
      ],
      [
        {
          id: 'ab',
          source: { nodeId: 'a', portName: 'out' },
          target: { nodeId: 'b', portName: 'in' },
        },
      ],
    )
    const result = planWorkflowLayout(def, { semanticContext: semantic })
    expect(result.next.nodes[0]).toMatchObject({
      position: { x: 100, y: 100 },
      size: { width: 220, height: 140, sizeLocked: true },
    })
    expect(result.warnings).toContainEqual({
      code: 'size-locked-overflow',
      wrapperNodeId: 'wrap',
    })
  })
})
