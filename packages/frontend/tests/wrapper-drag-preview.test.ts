// Regression lock for live wrapper acceptance feedback.
//
// Before this test, wrapper membership and fit ran only in onNodeDragStop: a
// node could be over a valid wrapper with the mouse still held down while the
// wrapper remained completely static, making the drop target look disabled.
// These cases lock the pre-release preview while preserving the existing
// center-hit rule and keeping all persisted workflow data untouched.

import { describe, expect, test } from 'vitest'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import type { Node } from '@xyflow/react'
import { projectDefinitionForXyflow } from '../src/components/canvas/coordProjection'
import {
  applyWrapperDragPreviews,
  clearWrapperDragPreviews,
  computeWrapperDragPreviews,
  WRAPPER_DRAG_PREVIEW_DATA_KEY,
} from '../src/components/canvas/wrapperDragPreview'

const AGENT_SIZE = { width: 280, height: 180 }

function wrapper(
  id: string,
  nodeIds: string[],
  position: { x: number; y: number },
  size: { width: number; height: number; sizeLocked?: boolean },
): WorkflowNode {
  return {
    id,
    kind: 'wrapper-git',
    nodeIds,
    position,
    size,
  } as unknown as WorkflowNode
}

function agent(id: string, position: { x: number; y: number }): WorkflowNode {
  return {
    id,
    kind: 'agent-single',
    agentName: 'coder',
    position,
  } as unknown as WorkflowNode
}

function definition(nodes: WorkflowNode[]): WorkflowDefinition {
  return {
    $schema_version: 2,
    inputs: [],
    nodes,
    edges: [],
  } as WorkflowDefinition
}

function flowNodes(def: WorkflowDefinition): Node[] {
  const raw = def.nodes.map((node) => ({
    id: node.id,
    type: node.kind,
    position: node.position ?? { x: 0, y: 0 },
    data: {},
  })) as Node[]
  return projectDefinitionForXyflow(def, raw, new Map([['a', AGENT_SIZE]]))
}

function move(flow: Node[], id: string, position: { x: number; y: number }): Node[] {
  return flow.map((node) => (node.id === id ? { ...node, position } : node))
}

describe('computeWrapperDragPreviews', () => {
  test('grows an accepting wrapper around the whole node before mouseup', () => {
    const def = definition([
      wrapper('w', [], { x: 100, y: 100 }, { width: 200, height: 160 }),
      // Center (250, 210) is inside the base wrapper, while most of this
      // 280x180 card extends beyond its right/bottom edges.
      agent('a', { x: 110, y: 120 }),
    ])
    const previews = computeWrapperDragPreviews({
      definition: def,
      flowNodes: flowNodes(def),
      draggedNodeIds: ['a'],
      measuredSizes: new Map([['a', AGENT_SIZE]]),
    })

    expect(previews.get('w')).toEqual({
      state: 'accept',
      offsetX: -46,
      offsetY: -42,
      width: 392,
      height: 282,
    })
    // Preview calculation is detached: no speculative nodeIds/size write.
    expect((def.nodes[0] as unknown as { nodeIds: string[] }).nodeIds).toEqual([])
    expect((def.nodes[0] as unknown as { size: unknown }).size).toEqual({
      width: 200,
      height: 160,
    })
  })

  test('shows no accepting preview when the node center is outside', () => {
    const def = definition([
      wrapper('w', [], { x: 100, y: 100 }, { width: 200, height: 160 }),
      agent('a', { x: 500, y: 500 }),
    ])
    const previews = computeWrapperDragPreviews({
      definition: def,
      flowNodes: flowNodes(def),
      draggedNodeIds: ['a'],
      measuredSizes: new Map([['a', AGENT_SIZE]]),
    })
    expect(previews.size).toBe(0)
  })

  test('expanded preview is not sticky after the pointer leaves the base drop area', () => {
    const def = definition([
      wrapper('w', [], { x: 100, y: 100 }, { width: 200, height: 160 }),
      agent('a', { x: 110, y: 120 }),
    ])
    const baseFlow = flowNodes(def)
    const first = computeWrapperDragPreviews({
      definition: def,
      flowNodes: baseFlow,
      draggedNodeIds: ['a'],
      measuredSizes: new Map([['a', AGENT_SIZE]]),
    })
    const withExpandedVisual = applyWrapperDragPreviews(baseFlow, first)
    const afterLeaving = move(withExpandedVisual, 'a', { x: 700, y: 600 })
    const next = computeWrapperDragPreviews({
      definition: def,
      flowNodes: afterLeaving,
      draggedNodeIds: ['a'],
      measuredSizes: new Map([['a', AGENT_SIZE]]),
    })
    expect(next.size).toBe(0)
  })

  test('marks the current wrapper as leaving when its child crosses outside', () => {
    const def = definition([
      wrapper('w', ['a'], { x: 100, y: 100 }, { width: 500, height: 400 }),
      agent('a', { x: 160, y: 170 }),
    ])
    const projected = flowNodes(def)
    // Child positions are parent-relative in xyflow. This moves the absolute
    // center far beyond the wrapper while the workflow membership is unchanged.
    const dragged = move(projected, 'a', { x: 600, y: 500 })
    const previews = computeWrapperDragPreviews({
      definition: def,
      flowNodes: dragged,
      draggedNodeIds: ['a'],
      measuredSizes: new Map([['a', AGENT_SIZE]]),
    })
    expect(previews.get('w')).toEqual({ state: 'leave' })
  })

  test('keeps manual size lock while still highlighting a valid target', () => {
    const def = definition([
      wrapper('w', [], { x: 100, y: 100 }, { width: 200, height: 160, sizeLocked: true }),
      agent('a', { x: 110, y: 120 }),
    ])
    const previews = computeWrapperDragPreviews({
      definition: def,
      flowNodes: flowNodes(def),
      draggedNodeIds: ['a'],
      measuredSizes: new Map([['a', AGENT_SIZE]]),
    })
    expect(previews.get('w')).toEqual({
      state: 'accept',
      offsetX: 0,
      offsetY: 0,
      width: 200,
      height: 160,
    })
  })

  test('accept preview also honors a port-heavy wrapper intrinsic width', () => {
    const target = {
      ...wrapper('w', [], { x: 100, y: 100 }, { width: 200, height: 160 }),
      kind: 'wrapper-loop',
      outputBindings: ['1', '2', '3', '4', '5', '6'].map((suffix) => ({
        name: `result_${suffix}`,
        bind: { nodeId: 'a', portName: 'out' },
      })),
    } as unknown as WorkflowNode
    const def = definition([target, agent('a', { x: 110, y: 120 })])
    const projected = flowNodes(def).map((node) =>
      node.id === 'w'
        ? {
            ...node,
            data: {
              ...node.data,
              inputPorts: [],
              outputPorts: ['result_1', 'result_2', 'result_3', 'result_4', 'result_5', 'result_6'],
            },
          }
        : node,
    )
    const previews = computeWrapperDragPreviews({
      definition: def,
      flowNodes: projected,
      draggedNodeIds: ['a'],
      measuredSizes: new Map([['a', AGENT_SIZE]]),
    })
    expect(previews.get('w')?.width).toBe(532)
  })
})

describe('wrapper preview node-data adapter', () => {
  test('adds and clears only local wrapper data', () => {
    const def = definition([
      wrapper('w', [], { x: 100, y: 100 }, { width: 200, height: 160 }),
      agent('a', { x: 110, y: 120 }),
    ])
    const base = flowNodes(def)
    const candidate = base.find((node) => node.id === 'a')
    const previews = new Map([
      ['w', { state: 'accept' as const, offsetX: -10, offsetY: -20, width: 300, height: 260 }],
    ])
    const applied = applyWrapperDragPreviews(base, previews)
    const wrapperNode = applied.find((node) => node.id === 'w')

    expect(applied).not.toBe(base)
    expect(applied.find((node) => node.id === 'a')).toBe(candidate)
    expect((wrapperNode?.data as Record<string, unknown>)[WRAPPER_DRAG_PREVIEW_DATA_KEY]).toEqual(
      previews.get('w'),
    )
    expect(wrapperNode?.position).toEqual(base.find((node) => node.id === 'w')?.position)
    expect(wrapperNode?.parentId).toBe(base.find((node) => node.id === 'w')?.parentId)

    const cleared = clearWrapperDragPreviews(applied)
    const clearedWrapper = cleared.find((node) => node.id === 'w')
    expect(
      (clearedWrapper?.data as Record<string, unknown>)[WRAPPER_DRAG_PREVIEW_DATA_KEY],
    ).toBeUndefined()
    expect(clearWrapperDragPreviews(cleared)).toBe(cleared)
  })
})
