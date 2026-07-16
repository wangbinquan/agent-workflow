// canvasClipboard: slice extraction + paste id-remapping (P-2-07).

import { describe, expect, test } from 'vitest'
import type { WorkflowDefinition } from '@agent-workflow/shared'
import {
  __testApplyPaste as applyPaste,
  __testBuildSlice as buildSlice,
  ClipboardInvariantError,
} from '../src/components/canvas/canvasClipboard'

const SOURCE_WORKFLOW_ID = 'workflow-source'

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
    expect(buildSlice(DEF, ['ghost'], SOURCE_WORKFLOW_ID)).toBeNull()
  })

  test('keeps only edges entirely inside the selection', () => {
    const slice = buildSlice(DEF, ['a', 'b'], SOURCE_WORKFLOW_ID)
    expect(slice?.nodes.map((n) => n.id)).toEqual(['a', 'b'])
    // e1 is inside; e2 spans b→c so it's dropped.
    expect(slice?.edges.map((e) => e.id)).toEqual(['e1'])
  })

  test('anchors to the top-left node position', () => {
    const slice = buildSlice(DEF, ['b', 'c'], SOURCE_WORKFLOW_ID)
    expect(slice?.anchor).toEqual({ x: 300, y: 200 })
  })

  test('materializes distinct canonical positions for multiple legacy nodes without position', () => {
    const legacy: WorkflowDefinition = {
      ...DEF,
      nodes: [
        { id: 'legacy-a', kind: 'agent-single' },
        { id: 'legacy-b', kind: 'agent-single' },
      ],
      edges: [],
    }

    const slice = buildSlice(legacy, ['legacy-a', 'legacy-b'], SOURCE_WORKFLOW_ID)!

    expect(slice.anchor).toEqual({ x: 80, y: 80 })
    expect(slice.nodes.map((node) => node.position)).toEqual([
      { x: 80, y: 80 },
      { x: 360, y: 80 },
    ])
  })

  test('records source workflow id and expands nested wrapper child closure', () => {
    const def: WorkflowDefinition = {
      ...DEF,
      nodes: [
        {
          id: 'outer',
          kind: 'wrapper-fanout',
          nodeIds: ['inner-wrapper'],
          position: { x: 0, y: 0 },
        },
        {
          id: 'inner-wrapper',
          kind: 'wrapper-loop',
          nodeIds: ['inner'],
          position: { x: 20, y: 20 },
        },
        { id: 'inner', kind: 'agent-single', position: { x: 40, y: 40 } },
        { id: 'outside', kind: 'agent-single', position: { x: 400, y: 40 } },
      ],
      edges: [
        {
          id: 'boundary',
          source: { nodeId: 'outer', portName: 'item' },
          target: { nodeId: 'inner', portName: 'item' },
          boundary: 'wrapper-input',
        },
        {
          id: 'crossing',
          source: { nodeId: 'inner', portName: 'out' },
          target: { nodeId: 'outside', portName: 'in' },
        },
      ],
    }

    const slice = buildSlice(def, ['outer'], SOURCE_WORKFLOW_ID)
    expect(slice?.sourceWorkflowId).toBe(SOURCE_WORKFLOW_ID)
    expect(slice?.nodes.map((node) => node.id)).toEqual(['outer', 'inner-wrapper', 'inner'])
    expect(slice?.edges).toEqual([def.edges[0]])
  })

  test('fails closed when a copied input declaration is missing or duplicated', () => {
    const inputNode = { id: 'input', kind: 'input', inputKey: 'upload' } as const
    const missing: WorkflowDefinition = { ...DEF, nodes: [inputNode], edges: [], inputs: [] }
    expect(() => buildSlice(missing, ['input'], SOURCE_WORKFLOW_ID)).toThrowError(
      expect.objectContaining({ code: 'input-declaration-missing' }),
    )

    const declaration = {
      kind: 'upload',
      key: 'upload',
      label: 'Upload',
      targetDir: 'docs',
    } as const
    const duplicate: WorkflowDefinition = {
      ...missing,
      inputs: [declaration, { ...declaration }],
    }
    expect(() => buildSlice(duplicate, ['input'], SOURCE_WORKFLOW_ID)).toThrowError(
      expect.objectContaining({ code: 'input-declaration-duplicate' }),
    )
  })

  test('fails closed on cyclic wrapper membership before projection can recurse', () => {
    const cyclic: WorkflowDefinition = {
      ...DEF,
      nodes: [
        { id: 'a', kind: 'wrapper-git', nodeIds: ['b'] },
        { id: 'b', kind: 'wrapper-loop', nodeIds: ['a'] },
      ],
      edges: [],
    }
    expect(() => buildSlice(cyclic, ['a'], SOURCE_WORKFLOW_ID)).toThrowError(
      expect.objectContaining({ code: 'wrapper-membership-cycle' }),
    )
  })
})

describe('applyPaste', () => {
  test('appends nodes + edges with fresh ids and offset positions', () => {
    const slice = buildSlice(DEF, ['a', 'b'], SOURCE_WORKFLOW_ID)!
    const result = applyPaste(DEF, slice, { x: 500, y: 500 })
    expect(result.newNodeIds).toEqual(['a_copy', 'b_copy'])
    expect(result.definition.nodes).toHaveLength(5)
    // Pasted positions: anchor (100,200) → (500,500) means dx=400 dy=300.
    const aCopy = result.definition.nodes.find((n) => n.id === 'a_copy')
    expect(aCopy?.position).toEqual({ x: 500, y: 500 })
    const bCopy = result.definition.nodes.find((n) => n.id === 'b_copy')
    expect(bCopy?.position).toEqual({ x: 700, y: 500 })
  })

  test('pasting multiple legacy nodes without position preserves their non-overlapping layout', () => {
    const source: WorkflowDefinition = {
      ...DEF,
      nodes: [
        { id: 'legacy-a', kind: 'agent-single' },
        { id: 'legacy-b', kind: 'agent-single' },
      ],
      edges: [],
    }
    const target: WorkflowDefinition = { ...DEF, nodes: [], edges: [] }
    const slice = buildSlice(source, ['legacy-a', 'legacy-b'], SOURCE_WORKFLOW_ID)!

    const result = applyPaste(target, slice, { x: 500, y: 400 })

    expect(result.definition.nodes.map((node) => node.position)).toEqual([
      { x: 500, y: 400 },
      { x: 780, y: 400 },
    ])
  })

  test('remaps edge endpoints onto the new ids', () => {
    const slice = buildSlice(DEF, ['a', 'b'], SOURCE_WORKFLOW_ID)!
    const result = applyPaste(DEF, slice, { x: 0, y: 0 })
    const added = result.definition.edges.filter(
      (e) => e.source.nodeId === 'a_copy' && e.target.nodeId === 'b_copy',
    )
    expect(added).toHaveLength(1)
  })

  test('handles repeated paste by bumping the suffix', () => {
    const slice = buildSlice(DEF, ['a'], SOURCE_WORKFLOW_ID)!
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
    const slice = buildSlice(def, ['a'], SOURCE_WORKFLOW_ID)!
    const result = applyPaste(def, slice, { x: 100, y: 100 })
    const copy = result.definition.nodes.find((n) => n.id === 'a_copy') as Record<string, unknown>
    expect(copy.agentName).toBe('coder')
    expect(copy.promptTemplate).toBe('do {{x}}')
  })

  test('rewrites the full nested reference inventory and preserves boundary metadata', () => {
    const def: WorkflowDefinition = {
      $schema_version: 4,
      inputs: [
        {
          kind: 'upload',
          key: 'docs',
          label: 'Documents',
          required: true,
          description: 'Source documents',
          targetDir: 'incoming',
          accept: ['.pdf'],
          minCount: 1,
          maxCount: 3,
          maxFileSize: 4096,
        },
      ],
      nodes: [
        {
          id: 'outer',
          kind: 'wrapper-fanout',
          nodeIds: ['loop'],
          position: { x: 0, y: 0 },
        },
        {
          id: 'loop',
          kind: 'wrapper-loop',
          nodeIds: ['input-a', 'input-b', 'review', 'output'],
          exitCondition: { kind: 'port-not-empty', nodeId: 'input-a', portName: 'docs' },
          outputBindings: [{ name: 'result', bind: { nodeId: 'input-b', portName: 'docs' } }],
          position: { x: 20, y: 20 },
        },
        { id: 'input-a', kind: 'input', inputKey: 'docs', position: { x: 40, y: 40 } },
        { id: 'input-b', kind: 'input', inputKey: 'docs', position: { x: 40, y: 160 } },
        {
          id: 'review',
          kind: 'review',
          inputSource: { nodeId: 'input-a', portName: 'docs' },
          rerunnableOnReject: ['input-a', 'input-b'],
          rerunnableOnIterate: ['input-b'],
          position: { x: 280, y: 40 },
        },
        {
          id: 'output',
          kind: 'output',
          ports: [{ name: 'final', bind: { nodeId: 'input-b', portName: 'docs' } }],
          position: { x: 520, y: 40 },
        },
      ],
      edges: [
        {
          id: 'boundary',
          source: { nodeId: 'outer', portName: 'docs' },
          target: { nodeId: 'input-a', portName: 'docs' },
          boundary: 'wrapper-input',
        },
        {
          id: 'input-to-review',
          source: { nodeId: 'input-a', portName: 'docs' },
          target: { nodeId: 'review', portName: 'in' },
        },
      ],
    }

    const slice = buildSlice(def, ['outer'], SOURCE_WORKFLOW_ID)!
    const result = applyPaste(def, slice, { x: 800, y: 400 })

    const copiedOuter = result.definition.nodes.find((node) => node.id === 'outer_copy') as Record<
      string,
      unknown
    >
    const copiedLoop = result.definition.nodes.find((node) => node.id === 'loop_copy') as Record<
      string,
      unknown
    >
    const copiedReview = result.definition.nodes.find(
      (node) => node.id === 'review_copy',
    ) as Record<string, unknown>
    const copiedOutput = result.definition.nodes.find(
      (node) => node.id === 'output_copy',
    ) as Record<string, unknown>
    const copiedInputs = result.definition.nodes.filter((node) =>
      ['input-a_copy', 'input-b_copy'].includes(node.id),
    ) as Array<Record<string, unknown>>

    expect(copiedOuter.nodeIds).toEqual(['loop_copy'])
    expect(copiedLoop.nodeIds).toEqual([
      'input-a_copy',
      'input-b_copy',
      'review_copy',
      'output_copy',
    ])
    expect(copiedLoop.exitCondition).toMatchObject({
      nodeId: 'input-a_copy',
      portName: 'docs_copy',
    })
    expect(copiedLoop.outputBindings).toEqual([
      { name: 'result', bind: { nodeId: 'input-b_copy', portName: 'docs_copy' } },
    ])
    expect(copiedReview.inputSource).toEqual({
      nodeId: 'input-a_copy',
      portName: 'docs_copy',
    })
    expect(copiedReview.rerunnableOnReject).toEqual(['input-a_copy', 'input-b_copy'])
    expect(copiedReview.rerunnableOnIterate).toEqual(['input-b_copy'])
    expect(copiedOutput.ports).toEqual([
      { name: 'final', bind: { nodeId: 'input-b_copy', portName: 'docs_copy' } },
    ])
    expect(copiedInputs.map((node) => node.inputKey)).toEqual(['docs_copy', 'docs_copy'])

    const copiedBoundary = result.definition.edges.find(
      (edge) => edge.source.nodeId === 'outer_copy' && edge.target.nodeId === 'input-a_copy',
    )
    expect(copiedBoundary).toMatchObject({
      source: { nodeId: 'outer_copy', portName: 'docs' },
      target: { nodeId: 'input-a_copy', portName: 'docs_copy' },
      boundary: 'wrapper-input',
    })
    expect(
      result.definition.edges.find(
        (edge) => edge.source.nodeId === 'input-a_copy' && edge.target.nodeId === 'review_copy',
      )?.source.portName,
    ).toBe('docs_copy')

    const copiedDeclaration = result.definition.inputs.find((input) => input.key === 'docs_copy')
    expect(copiedDeclaration).toEqual({
      kind: 'upload',
      key: 'docs_copy',
      label: 'Documents',
      required: true,
      description: 'Source documents',
      targetDir: 'incoming',
      accept: ['.pdf'],
      minCount: 1,
      maxCount: 3,
      maxFileSize: 4096,
    })
    expect(result.definition.inputs.filter((input) => input.key === 'docs_copy')).toHaveLength(1)
  })

  test('preserves a shared key across workflows when the target has no collision', () => {
    const source: WorkflowDefinition = {
      $schema_version: 4,
      inputs: [{ kind: 'files', key: 'files', label: 'Files', description: 'Pick files' }],
      nodes: [
        { id: 'first', kind: 'input', inputKey: 'files' },
        { id: 'second', kind: 'input', inputKey: 'files' },
      ],
      edges: [
        {
          id: 'shared',
          source: { nodeId: 'first', portName: 'files' },
          target: { nodeId: 'second', portName: 'files' },
        },
      ],
    }
    const target: WorkflowDefinition = {
      $schema_version: 4,
      inputs: [],
      nodes: [{ id: 'existing', kind: 'agent-single' }],
      edges: [],
    }
    const slice = buildSlice(source, ['first', 'second'], 'workflow-a')!
    const result = applyPaste(target, slice, { x: 0, y: 0 })

    expect(slice.sourceWorkflowId).toBe('workflow-a')
    expect(result.definition.inputs).toEqual(source.inputs)
    expect(
      result.definition.nodes
        .filter((node) => node.kind === 'input')
        .map((node) => (node as Record<string, unknown>).inputKey),
    ).toEqual(['files', 'files'])
    expect(result.definition.edges[0]?.source.portName).toBe('files')
  })

  test('clears references outside the slice and returns a structured warning', () => {
    const source: WorkflowDefinition = {
      ...DEF,
      nodes: [
        { id: 'outside', kind: 'agent-single' },
        {
          id: 'review',
          kind: 'review',
          inputSource: { nodeId: 'outside', portName: 'report' },
          rerunnableOnReject: ['outside'],
          rerunnableOnIterate: [],
        },
      ],
      edges: [],
    }
    const slice = buildSlice(source, ['review'], SOURCE_WORKFLOW_ID)!
    const result = applyPaste(source, slice, { x: 0, y: 0 })
    const copied = result.definition.nodes.find((node) => node.id === 'review_copy') as Record<
      string,
      unknown
    >

    expect(copied.inputSource).toEqual({ nodeId: '', portName: '' })
    expect(copied.rerunnableOnReject).toEqual([])
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'copy-reference-outside-slice',
          nodeId: 'review',
          referencedNodeId: 'outside',
        }),
      ]),
    )
  })

  test('rejects a corrupted payload or unmanaged passthrough reference without mutation', () => {
    const target = structuredClone(DEF)
    const inputSource: WorkflowDefinition = {
      ...DEF,
      inputs: [{ kind: 'text', key: 'topic', label: 'Topic' }],
      nodes: [{ id: 'input', kind: 'input', inputKey: 'topic' }],
      edges: [],
    }
    const corrupted = buildSlice(inputSource, ['input'], SOURCE_WORKFLOW_ID)!
    corrupted.inputDeclarations = []
    expect(() => applyPaste(target, corrupted, { x: 0, y: 0 })).toThrowError(
      expect.objectContaining({ code: 'input-declaration-missing' }),
    )
    expect(target).toEqual(DEF)

    const unmanaged: WorkflowDefinition = {
      ...DEF,
      nodes: [
        {
          id: 'a',
          kind: 'agent-single',
          mysteryNodeId: 'b',
        } as unknown as WorkflowDefinition['nodes'][number],
        { id: 'b', kind: 'agent-single' },
      ],
      edges: [],
    }
    const slice = buildSlice(unmanaged, ['a'], SOURCE_WORKFLOW_ID)!
    let caught: unknown
    try {
      applyPaste(unmanaged, slice, { x: 0, y: 0 })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ClipboardInvariantError)
    expect(caught).toMatchObject({ code: 'node-reference-rewrite-unsafe' })
  })
})
