// RFC-302 — Intent workflow create ops are laid out before draft hashing.
// These pure-domain locks protect create-only scope, reference identity,
// deterministic geometry, and fail-closed malformed/locked-wrapper paths.

import { describe, expect, test } from 'bun:test'
import {
  canonicalIntentJson,
  parseIntentChangeset,
  type IntentChangeset,
} from '@agent-workflow/shared'
import {
  INTENT_WORKFLOW_LAYOUT_ORIGIN,
  normalizeIntentWorkflowCreateLayouts,
} from '../src/modules/intent/domain/workflowCreateLayout'

function parsed(value: unknown): IntentChangeset {
  const result = parseIntentChangeset(JSON.stringify(value))
  if (!result.ok) throw new Error(result.errors.join('\n'))
  return result.changeset
}

function workflowOp(
  definition: Record<string, unknown>,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    opId: 'op-1',
    action: 'create',
    resourceType: 'workflow',
    tempRef: '$new:flow',
    payload: { name: 'Intent flow', description: '', definition },
    ...over,
  }
}

function changeset(ops: Record<string, unknown>[]): IntentChangeset {
  return parsed({ $schema_version: 1, ops })
}

function dagDefinition(): Record<string, unknown> {
  return {
    $schema_version: 5,
    inputs: [],
    nodes: [
      { id: 'source', kind: 'input', inputKey: 'goal', position: { x: -900, y: 800 } },
      {
        id: 'worker',
        kind: 'agent-single',
        agentRef: 'res#agent#1',
        position: { x: -900, y: 800 },
      },
      { id: 'sink', kind: 'output', position: { x: -900, y: 800 } },
    ],
    edges: [
      {
        id: 'source-worker',
        source: { nodeId: 'source', portName: 'value' },
        target: { nodeId: 'worker', portName: 'goal' },
      },
      {
        id: 'worker-sink',
        source: { nodeId: 'worker', portName: 'out' },
        target: { nodeId: 'sink', portName: 'value' },
      },
    ],
  }
}

function withoutLayoutGeometry(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutLayoutGeometry)
  if (value === null || typeof value !== 'object') return value
  const source = value as Record<string, unknown>
  const next: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(source)) {
    if (key === 'position') continue
    if (key === 'size' && item !== null && typeof item === 'object') {
      const { width: _width, height: _height, ...rest } = item as Record<string, unknown>
      if (Object.keys(rest).length > 0) next.size = withoutLayoutGeometry(rest)
      continue
    }
    next[key] = withoutLayoutGeometry(item)
  }
  return next
}

describe('RFC-302 Intent create-workflow layout domain', () => {
  test('lays out an overlapping DAG at the fixed origin without mutating identity or input', () => {
    const input = changeset([workflowOp(dagDefinition())])
    const before = structuredClone(input)
    const result = normalizeIntentWorkflowCreateLayouts(input)

    expect(result.errors).toEqual([])
    expect(input).toEqual(before)
    const op = result.changeset.ops[0]!
    if (op.resourceType !== 'workflow') throw new Error('expected workflow op')
    const definition = op.payload.definition
    const positions = new Map(
      definition.nodes.map((node) => [node.id, node.position as { x: number; y: number }]),
    )
    expect(Math.min(...[...positions.values()].map((position) => position.x))).toBe(
      INTENT_WORKFLOW_LAYOUT_ORIGIN.x,
    )
    expect(Math.min(...[...positions.values()].map((position) => position.y))).toBe(
      INTENT_WORKFLOW_LAYOUT_ORIGIN.y,
    )
    expect(positions.get('source')!.x).toBeLessThan(positions.get('worker')!.x)
    expect(positions.get('worker')!.x).toBeLessThan(positions.get('sink')!.x)
    expect(definition.nodes.map((node) => node.id)).toEqual(['source', 'worker', 'sink'])
    expect(definition.edges.map((edge) => (edge as { id: string }).id)).toEqual([
      'source-worker',
      'worker-sink',
    ])
    expect(definition.nodes[1]).toMatchObject({ agentRef: 'res#agent#1' })
    expect(definition.nodes[1]).not.toHaveProperty('agentId')
    expect(withoutLayoutGeometry(result.changeset)).toEqual(withoutLayoutGeometry(input))
  })

  test('is canonical-byte deterministic across replay and idempotent after geometry exists', () => {
    const input = changeset([workflowOp(dagDefinition())])
    const first = normalizeIntentWorkflowCreateLayouts(input)
    const canonical = canonicalIntentJson(first.changeset)
    for (let index = 0; index < 100; index += 1) {
      expect(canonicalIntentJson(normalizeIntentWorkflowCreateLayouts(input).changeset)).toBe(
        canonical,
      )
    }
    const second = normalizeIntentWorkflowCreateLayouts(first.changeset)
    expect(canonicalIntentJson(second.changeset)).toBe(canonical)
  })

  test('lays out each create independently while update/copy and non-workflow ops stay exact', () => {
    const createA = workflowOp(dagDefinition())
    const createB = workflowOp(dagDefinition(), {
      opId: 'op-2',
      tempRef: '$new:flow-2',
      payload: { name: 'Second flow', description: '', definition: dagDefinition() },
    })
    const update = {
      ...workflowOp(dagDefinition()),
      opId: 'op-3',
      action: 'update',
      target: 'res#workflow#1',
      tempRef: undefined,
    }
    delete (update as Record<string, unknown>).tempRef
    const agent = {
      opId: 'op-4',
      action: 'create',
      resourceType: 'agent',
      tempRef: '$new:worker',
      payload: {
        name: 'worker',
        description: '',
        outputs: [],
        skills: [],
        dependsOn: [],
        mcp: [],
        plugins: [],
        bodyMd: 'work',
      },
    }
    const input = changeset([createA, createB, update, agent])
    const result = normalizeIntentWorkflowCreateLayouts(input)
    expect(result.errors).toEqual([])
    expect(result.changeset.ops[2]).toBe(input.ops[2])
    expect(result.changeset.ops[3]).toBe(input.ops[3])
    for (const index of [0, 1]) {
      const op = result.changeset.ops[index]!
      if (op.resourceType !== 'workflow') throw new Error('expected workflow')
      expect(op.payload.definition.nodes.every((node) => node.position !== undefined)).toBe(true)
    }
  })

  test('preserves call handles, script secret carriers, business fields, and array order', () => {
    const definition = dagDefinition()
    const nodes = definition.nodes as Record<string, unknown>[]
    nodes.splice(
      2,
      0,
      {
        id: 'call',
        kind: 'call-workflow',
        workflowRef: 'res#workflow#2',
        workflowName: 'child',
        inputMappings: { goal: '{{worker.out}}' },
      },
      {
        id: 'script',
        kind: 'script',
        language: 'bash',
        script: 'echo ok',
        env: { API_TOKEN: '‹secret›' },
      },
    )
    const input = changeset([workflowOp(definition)])
    const result = normalizeIntentWorkflowCreateLayouts(input)
    const op = result.changeset.ops[0]!
    if (op.resourceType !== 'workflow') throw new Error('expected workflow')
    expect(op.payload.definition.nodes.map((node) => node.id)).toEqual([
      'source',
      'worker',
      'call',
      'script',
      'sink',
    ])
    expect(op.payload.definition.nodes[2]).toMatchObject({
      workflowRef: 'res#workflow#2',
      workflowName: 'child',
      inputMappings: { goal: '{{worker.out}}' },
    })
    expect(op.payload.definition.nodes[2]).not.toHaveProperty('workflowId')
    expect(op.payload.definition.nodes[3]).toMatchObject({ env: { API_TOKEN: '‹secret›' } })
  })

  test('keeps legal execution cycles and reports only the stable back-edge warning', () => {
    const definition = dagDefinition()
    ;(definition.edges as Record<string, unknown>[]).push({
      id: 'cycle',
      source: { nodeId: 'sink', portName: 'value' },
      target: { nodeId: 'source', portName: 'value' },
    })
    const result = normalizeIntentWorkflowCreateLayouts(changeset([workflowOp(definition)]))
    expect(result.errors).toEqual([])
    expect(result.warnings).toEqual([
      {
        opId: 'op-1',
        warning: { code: 'cycle-back-edge', edgeId: 'worker-sink' },
      },
    ])
    expect(normalizeIntentWorkflowCreateLayouts(changeset([workflowOp(definition)]))).toEqual(
      result,
    )
  })

  test('blocks a size-locked wrapper overflow with an op-owned stable error', () => {
    const definition = {
      $schema_version: 5,
      inputs: [],
      nodes: [
        {
          id: 'wrap',
          kind: 'wrapper-git',
          nodeIds: ['a', 'b'],
          position: { x: 0, y: 0 },
          size: { width: 220, height: 140, sizeLocked: true },
        },
        { id: 'a', kind: 'agent-single', agentRef: 'res#agent#1' },
        { id: 'b', kind: 'agent-single', agentRef: 'res#agent#1' },
      ],
      edges: [
        {
          id: 'ab',
          source: { nodeId: 'a', portName: 'out' },
          target: { nodeId: 'b', portName: 'in' },
        },
      ],
    }
    const result = normalizeIntentWorkflowCreateLayouts(changeset([workflowOp(definition)]))
    expect(result.errors).toEqual([
      'op-1: size-locked wrapper wrap cannot contain its laid-out children (intent-workflow-layout-size-locked-overflow)',
    ])
  })

  test('lays out nested wrappers inside-out and persists fitted rectangles', () => {
    const definition = {
      $schema_version: 5,
      inputs: [],
      nodes: [
        { id: 'outer', kind: 'wrapper-loop', nodeIds: ['inner'] },
        { id: 'inner', kind: 'wrapper-git', nodeIds: ['a', 'b'] },
        { id: 'a', kind: 'agent-single', agentRef: 'res#agent#1' },
        { id: 'b', kind: 'agent-single', agentRef: 'res#agent#1' },
      ],
      edges: [
        {
          id: 'ab',
          source: { nodeId: 'a', portName: 'out' },
          target: { nodeId: 'b', portName: 'in' },
        },
      ],
    }
    const result = normalizeIntentWorkflowCreateLayouts(changeset([workflowOp(definition)]))
    expect(result.errors).toEqual([])
    const op = result.changeset.ops[0]!
    if (op.resourceType !== 'workflow') throw new Error('expected workflow')
    expect(op.payload.definition.nodes.every((node) => node.position !== undefined)).toBe(true)
    const byId = new Map(op.payload.definition.nodes.map((node) => [node.id, node]))
    const outer = byId.get('outer') as Record<string, unknown>
    const inner = byId.get('inner') as Record<string, unknown>
    expect(outer.position).toEqual(INTENT_WORKFLOW_LAYOUT_ORIGIN)
    const outerPosition = outer.position as { x: number; y: number }
    const outerSize = outer.size as { width: number; height: number }
    const innerPosition = inner.position as { x: number; y: number }
    const innerSize = inner.size as { width: number; height: number }
    expect(
      [outerSize.width, outerSize.height, innerSize.width, innerSize.height].every(Number.isFinite),
    ).toBe(true)
    expect(innerPosition.x).toBeGreaterThan(outerPosition.x)
    expect(innerPosition.y).toBeGreaterThan(outerPosition.y)
    expect(innerPosition.x + innerSize.width).toBeLessThan(outerPosition.x + outerSize.width)
    expect(innerPosition.y + innerSize.height).toBeLessThan(outerPosition.y + outerSize.height)
  })

  test.each([
    {
      name: 'duplicate node id',
      mutate: (definition: Record<string, unknown>) => {
        ;(definition.nodes as Record<string, unknown>[])[1]!.id = 'source'
      },
    },
    {
      name: 'non-finite position',
      mutate: (definition: Record<string, unknown>) => {
        ;(definition.nodes as Record<string, unknown>[])[0]!.position = { x: Number.NaN, y: 0 }
      },
    },
    {
      name: 'missing edge endpoint',
      mutate: (definition: Record<string, unknown>) => {
        ;(definition.edges as Record<string, unknown>[])[0]!.target = {
          nodeId: 'missing',
          portName: 'in',
        }
      },
    },
    {
      name: 'cyclic wrapper membership',
      mutate: (definition: Record<string, unknown>) => {
        definition.nodes = [
          { id: 'a', kind: 'wrapper-git', nodeIds: ['b'] },
          { id: 'b', kind: 'wrapper-loop', nodeIds: ['a'] },
        ]
        definition.edges = []
      },
    },
  ])('fails closed without mutation for $name', ({ mutate }) => {
    const input = changeset([workflowOp(dagDefinition())])
    const op = input.ops[0]!
    if (op.resourceType !== 'workflow') throw new Error('expected workflow')
    mutate(op.payload.definition as Record<string, unknown>)
    const before = structuredClone(input)
    const result = normalizeIntentWorkflowCreateLayouts(input)
    expect(result.changeset).toBe(input)
    expect(result.changeset).toEqual(before)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toStartWith('op-1: workflow definition cannot be auto-laid out (')
    expect(result.errors[0]).toEndWith('(intent-workflow-layout-input-invalid)')
  })
})
