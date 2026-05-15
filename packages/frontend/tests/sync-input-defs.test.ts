// RFC-004 — syncInputDefs pure helper.
//
// Locks the editor-side contract that `definition.inputs[]` is the union of
// input nodes' inputKeys with user-customizable fields preserved across
// node edits. If this goes red, check
// packages/frontend/src/components/canvas/syncInputDefs.ts AND the scheduler's
// port-name contract in packages/backend/src/services/scheduler.ts:319 (they
// MUST move in lock-step — RFC-004 §13).

import type { WorkflowDefinition, WorkflowInput, WorkflowNode } from '@agent-workflow/shared'
import { describe, expect, test } from 'vitest'
import {
  patchInputDef,
  renameInputKey,
  syncInputDefs,
} from '../src/components/canvas/syncInputDefs'

function inputNode(id: string, key: string): WorkflowNode {
  return { id, kind: 'input', inputKey: key } as WorkflowNode
}

function agent(id: string): WorkflowNode {
  return { id, kind: 'agent-single', agentName: 'x' } as unknown as WorkflowNode
}

describe('syncInputDefs', () => {
  test('empty prev + one input node → default entry appended', () => {
    const next = syncInputDefs([], [inputNode('i1', 'requirement')])
    expect(next).toEqual([
      { kind: 'text', key: 'requirement', label: 'requirement', required: true },
    ])
  })

  test('preserves user-customized label / kind / required on referenced key', () => {
    const prev: WorkflowInput[] = [
      { kind: 'files', key: 'spec', label: '功能描述', required: false },
    ]
    const next = syncInputDefs(prev, [inputNode('i1', 'spec')])
    expect(next).toBe(prev) // ref-equality short-circuit when no change
  })

  test('drops orphan entries when no input node references the key', () => {
    const prev: WorkflowInput[] = [{ kind: 'text', key: 'gone', label: 'gone' }]
    const next = syncInputDefs(prev, [agent('a1')])
    expect(next).toEqual([])
  })

  test('rename: prev has old key, nodes have new key → swap', () => {
    const prev: WorkflowInput[] = [{ kind: 'text', key: 'old', label: 'old' }]
    const next = syncInputDefs(prev, [inputNode('i1', 'new')])
    expect(next).toEqual([{ kind: 'text', key: 'new', label: 'new', required: true }])
  })

  test('duplicate inputKey across two nodes does not create duplicate entries', () => {
    const next = syncInputDefs([], [inputNode('i1', 'shared'), inputNode('i2', 'shared')])
    expect(next).toHaveLength(1)
    expect(next[0]?.key).toBe('shared')
  })
})

function defWith(parts: Partial<WorkflowDefinition>): WorkflowDefinition {
  return { $schema_version: 1, inputs: [], nodes: [], edges: [], ...parts }
}

describe('renameInputKey', () => {
  test('renames the node + inputs entry + outbound edge in one shot', () => {
    const prev = defWith({
      inputs: [{ kind: 'text', key: 'old', label: '老' }],
      nodes: [
        inputNode('i1', 'old'),
        { id: 'a1', kind: 'agent-single' } as unknown as WorkflowNode,
      ],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'i1', portName: 'old' },
          target: { nodeId: 'a1', portName: 'old' },
        },
      ],
    })
    const next = renameInputKey(prev, 'i1', 'new')
    expect((next.nodes[0] as Record<string, unknown>).inputKey).toBe('new')
    expect(next.inputs[0]?.key).toBe('new')
    // RFC-004: preserve user-customized label across rename.
    expect(next.inputs[0]?.label).toBe('老')
    expect(next.edges[0]?.source.portName).toBe('new')
    // Target port name stays untouched — it's wired explicitly on the agent side.
    expect(next.edges[0]?.target.portName).toBe('old')
  })

  test('no-op when key unchanged', () => {
    const prev = defWith({
      nodes: [inputNode('i1', 'k')],
      inputs: [{ kind: 'text', key: 'k', label: 'k' }],
    })
    expect(renameInputKey(prev, 'i1', 'k')).toBe(prev)
  })

  test('no-op when target node is not an input node', () => {
    const prev = defWith({
      nodes: [{ id: 'a1', kind: 'agent-single' } as unknown as WorkflowNode],
    })
    expect(renameInputKey(prev, 'a1', 'newkey')).toBe(prev)
  })
})

describe('patchInputDef', () => {
  test('updates only the matched entry; preserves others', () => {
    const prev = defWith({
      inputs: [
        { kind: 'text', key: 'a', label: 'A' },
        { kind: 'text', key: 'b', label: 'B' },
      ],
    })
    const next = patchInputDef(prev, 'b', { kind: 'files', required: false })
    expect(next.inputs[0]).toBe(prev.inputs[0])
    expect(next.inputs[1]?.kind).toBe('files')
    expect(next.inputs[1]?.required).toBe(false)
    expect(next.inputs[1]?.label).toBe('B')
  })

  test('no-op when key not present (returns same reference)', () => {
    const prev = defWith({ inputs: [{ kind: 'text', key: 'a', label: 'A' }] })
    expect(patchInputDef(prev, 'missing', { label: 'X' })).toBe(prev)
  })
})
