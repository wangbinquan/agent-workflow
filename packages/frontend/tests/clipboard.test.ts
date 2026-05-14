// canvasClipboard: slice extraction + paste id-remapping (P-2-07).

import { describe, expect, test } from 'vitest'
import type { WorkflowDefinition } from '@agent-workflow/shared'
import {
  __testApplyPaste as applyPaste,
  __testBuildSlice as buildSlice,
} from '../src/components/canvas/canvasClipboard'

const DEF: WorkflowDefinition = {
  $schema_version: 1,
  inputs: [],
  nodes: [
    { id: 'a', kind: 'agent-single', position: { x: 100, y: 200 } },
    { id: 'b', kind: 'agent-single', position: { x: 300, y: 200 } },
    { id: 'c', kind: 'agent-single', position: { x: 500, y: 200 } },
  ],
  edges: [
    {
      id: 'e1',
      source: { nodeId: 'a', portName: 'out' },
      target: { nodeId: 'b', portName: 'in' },
    },
    {
      id: 'e2',
      source: { nodeId: 'b', portName: 'out' },
      target: { nodeId: 'c', portName: 'in' },
    },
  ],
}

describe('buildSlice', () => {
  test('returns null when no selected ids match', () => {
    expect(buildSlice(DEF, ['ghost'])).toBeNull()
  })

  test('keeps only edges entirely inside the selection', () => {
    const slice = buildSlice(DEF, ['a', 'b'])
    expect(slice?.nodes.map((n) => n.id)).toEqual(['a', 'b'])
    // e1 is inside; e2 spans b→c so it's dropped.
    expect(slice?.edges.map((e) => e.id)).toEqual(['e1'])
  })

  test('anchors to the top-left node position', () => {
    const slice = buildSlice(DEF, ['b', 'c'])
    expect(slice?.anchor).toEqual({ x: 300, y: 200 })
  })
})

describe('applyPaste', () => {
  test('appends nodes + edges with fresh ids and offset positions', () => {
    const slice = buildSlice(DEF, ['a', 'b'])!
    const result = applyPaste(DEF, slice, { x: 500, y: 500 })
    expect(result.newNodeIds).toEqual(['a_copy', 'b_copy'])
    expect(result.definition.nodes).toHaveLength(5)
    // Pasted positions: anchor (100,200) → (500,500) means dx=400 dy=300.
    const aCopy = result.definition.nodes.find((n) => n.id === 'a_copy')
    expect(aCopy?.position).toEqual({ x: 500, y: 500 })
    const bCopy = result.definition.nodes.find((n) => n.id === 'b_copy')
    expect(bCopy?.position).toEqual({ x: 700, y: 500 })
  })

  test('remaps edge endpoints onto the new ids', () => {
    const slice = buildSlice(DEF, ['a', 'b'])!
    const result = applyPaste(DEF, slice, { x: 0, y: 0 })
    const added = result.definition.edges.filter(
      (e) => e.source.nodeId === 'a_copy' && e.target.nodeId === 'b_copy',
    )
    expect(added).toHaveLength(1)
  })

  test('handles repeated paste by bumping the suffix', () => {
    const slice = buildSlice(DEF, ['a'])!
    const r1 = applyPaste(DEF, slice, { x: 10, y: 10 })
    const r2 = applyPaste(r1.definition, slice, { x: 20, y: 20 })
    expect(r2.newNodeIds[0]).toBe('a_copy_2')
  })

  test('preserves agent fields (agentName etc.) under structuredClone', () => {
    const def: WorkflowDefinition = {
      ...DEF,
      nodes: [
        {
          id: 'a',
          kind: 'agent-single',
          position: { x: 0, y: 0 },
          agentName: 'coder',
          promptTemplate: 'do {{x}}',
        } as unknown as WorkflowDefinition['nodes'][number],
      ],
      edges: [],
    }
    const slice = buildSlice(def, ['a'])!
    const result = applyPaste(def, slice, { x: 100, y: 100 })
    const copy = result.definition.nodes.find((n) => n.id === 'a_copy') as Record<string, unknown>
    expect(copy.agentName).toBe('coder')
    expect(copy.promptTemplate).toBe('do {{x}}')
  })
})
