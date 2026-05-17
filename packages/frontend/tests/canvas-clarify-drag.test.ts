// RFC-023 PR-C T16 — clarifyDragHelper pure-fn contract.
//
// Locks the reverse-drag interaction's three primitives:
//   - buildClarifyEdges always returns exactly two edges in (ask, ans)
//     order, on the four fixed system ports.
//   - isValidClarifyTarget accepts agent-{single,multi} only.
//   - hasExistingClarifyChannel detects the prior wiring before the second
//     drop fires (prevents the validator-level
//     `clarify-multiple-clarify-on-same-agent` from being the only line of
//     defense).
//   - applyClarifyReverseDrag is reference-stable on invalid drops + appends
//     both edges atomically on valid drops.
//   - clearClarifyEdgesForRemovedNodes cascades on node delete.

import { describe, expect, it } from 'vitest'
import type { WorkflowDefinition, WorkflowEdge, WorkflowNode } from '@agent-workflow/shared'
import {
  applyClarifyReverseDrag,
  buildClarifyEdges,
  CLARIFY_INPUT_PORT_NAME,
  CLARIFY_OUTPUT_PORT_NAME,
  CLARIFY_RESPONSE_TARGET_PORT_NAME,
  CLARIFY_SOURCE_PORT_NAME,
  clearClarifyEdgesForRemovedNodes,
  hasExistingClarifyChannel,
  isValidClarifyTarget,
} from '../src/components/canvas/clarifyDragHelper'

function node(
  partial: Partial<WorkflowNode> & { id: string; kind: WorkflowNode['kind'] },
): WorkflowNode {
  return { ...partial } as WorkflowNode
}

function defOf(nodes: WorkflowNode[], edges: WorkflowEdge[] = []): WorkflowDefinition {
  return {
    $schema_version: 3,
    inputs: [],
    nodes,
    edges,
    outputs: [],
  }
}

describe('buildClarifyEdges', () => {
  it('returns exactly two edges with the four system port names in (ask, ans) order', () => {
    const [ask, ans] = buildClarifyEdges('agent_designer', 'clarify_pick_db')
    expect(ask.source).toEqual({ nodeId: 'agent_designer', portName: CLARIFY_SOURCE_PORT_NAME })
    expect(ask.target).toEqual({ nodeId: 'clarify_pick_db', portName: CLARIFY_INPUT_PORT_NAME })
    expect(ans.source).toEqual({ nodeId: 'clarify_pick_db', portName: CLARIFY_OUTPUT_PORT_NAME })
    expect(ans.target).toEqual({
      nodeId: 'agent_designer',
      portName: CLARIFY_RESPONSE_TARGET_PORT_NAME,
    })
    // Distinct ids so xyflow doesn't dedupe one.
    expect(ask.id).not.toBe(ans.id)
    expect(ask.id.endsWith('_ask')).toBe(true)
    expect(ans.id.endsWith('_ans')).toBe(true)
  })
})

describe('isValidClarifyTarget', () => {
  it('accepts agent-single + agent-multi only', () => {
    expect(isValidClarifyTarget(node({ id: 'a', kind: 'agent-single' }))).toBe(true)
    expect(isValidClarifyTarget(node({ id: 'a', kind: 'agent-multi' }))).toBe(true)
    expect(isValidClarifyTarget(node({ id: 'a', kind: 'review' }))).toBe(false)
    expect(isValidClarifyTarget(node({ id: 'a', kind: 'output' }))).toBe(false)
    expect(isValidClarifyTarget(node({ id: 'a', kind: 'input' }))).toBe(false)
    expect(isValidClarifyTarget(node({ id: 'a', kind: 'wrapper-git' }))).toBe(false)
    expect(isValidClarifyTarget(node({ id: 'a', kind: 'wrapper-loop' }))).toBe(false)
    expect(isValidClarifyTarget(node({ id: 'a', kind: 'clarify' }))).toBe(false)
    expect(isValidClarifyTarget(undefined)).toBe(false)
  })
})

describe('hasExistingClarifyChannel', () => {
  it('detects an existing __clarify__ outbound edge on the agent', () => {
    const def = defOf(
      [node({ id: 'a', kind: 'agent-single' }), node({ id: 'c', kind: 'clarify' })],
      [
        {
          id: 'pre',
          source: { nodeId: 'a', portName: CLARIFY_SOURCE_PORT_NAME },
          target: { nodeId: 'c', portName: CLARIFY_INPUT_PORT_NAME },
        },
      ],
    )
    expect(hasExistingClarifyChannel(def, 'a')).toBe(true)
    expect(hasExistingClarifyChannel(def, 'b')).toBe(false)
    expect(hasExistingClarifyChannel(defOf([]), 'a')).toBe(false)
  })
})

describe('applyClarifyReverseDrag', () => {
  it('appends both edges on a valid drop onto agent-single', () => {
    const def = defOf([node({ id: 'a', kind: 'agent-single' }), node({ id: 'c', kind: 'clarify' })])
    const next = applyClarifyReverseDrag(def, {
      sourceAgentNodeId: 'a',
      clarifyNodeId: 'c',
    })
    expect(next).not.toBe(def)
    expect(next.edges.length).toBe(2)
    expect(
      next.edges.some(
        (e) =>
          e.source.portName === CLARIFY_SOURCE_PORT_NAME &&
          e.target.portName === CLARIFY_INPUT_PORT_NAME,
      ),
    ).toBe(true)
    expect(
      next.edges.some(
        (e) =>
          e.source.portName === CLARIFY_OUTPUT_PORT_NAME &&
          e.target.portName === CLARIFY_RESPONSE_TARGET_PORT_NAME,
      ),
    ).toBe(true)
  })

  it('rejects (returns by ref) when the agent already has a clarify channel', () => {
    const def = defOf(
      [
        node({ id: 'a', kind: 'agent-single' }),
        node({ id: 'c1', kind: 'clarify' }),
        node({ id: 'c2', kind: 'clarify' }),
      ],
      [
        {
          id: 'pre',
          source: { nodeId: 'a', portName: CLARIFY_SOURCE_PORT_NAME },
          target: { nodeId: 'c1', portName: CLARIFY_INPUT_PORT_NAME },
        },
      ],
    )
    const next = applyClarifyReverseDrag(def, {
      sourceAgentNodeId: 'a',
      clarifyNodeId: 'c2',
    })
    expect(next).toBe(def)
  })

  it('rejects (returns by ref) when the source is not an agent', () => {
    const def = defOf([node({ id: 'r', kind: 'review' }), node({ id: 'c', kind: 'clarify' })])
    const next = applyClarifyReverseDrag(def, {
      sourceAgentNodeId: 'r',
      clarifyNodeId: 'c',
    })
    expect(next).toBe(def)
  })

  it('accepts agent-multi (per design.md §2.3 — clarify-target-not-agent rejects only non-agents)', () => {
    const def = defOf([node({ id: 'm', kind: 'agent-multi' }), node({ id: 'c', kind: 'clarify' })])
    const next = applyClarifyReverseDrag(def, {
      sourceAgentNodeId: 'm',
      clarifyNodeId: 'c',
    })
    expect(next.edges.length).toBe(2)
  })
})

describe('clearClarifyEdgesForRemovedNodes', () => {
  it('removes clarify channel edges that reference a removed node id', () => {
    const def = defOf(
      [node({ id: 'a', kind: 'agent-single' }), node({ id: 'c', kind: 'clarify' })],
      buildClarifyEdges('a', 'c'),
    )
    const next = clearClarifyEdgesForRemovedNodes(def, ['c'])
    expect(next).not.toBe(def)
    expect(next.edges.length).toBe(0)
  })

  it('returns by ref when no clarify edges were affected', () => {
    const def = defOf([node({ id: 'a', kind: 'agent-single' })], [])
    expect(clearClarifyEdgesForRemovedNodes(def, ['a'])).toBe(def)
    expect(clearClarifyEdgesForRemovedNodes(def, [])).toBe(def)
  })

  it('preserves non-clarify edges that reference the removed node', () => {
    const otherEdge: WorkflowEdge = {
      id: 'other',
      source: { nodeId: 'in', portName: 'requirement' },
      target: { nodeId: 'a', portName: 'requirement' },
    }
    const def = defOf(
      [
        node({ id: 'in', kind: 'input' }),
        node({ id: 'a', kind: 'agent-single' }),
        node({ id: 'c', kind: 'clarify' }),
      ],
      [otherEdge, ...buildClarifyEdges('a', 'c')],
    )
    // Removing the clarify node should drop only the two clarify edges, not 'other'.
    const next = clearClarifyEdgesForRemovedNodes(def, ['c'])
    expect(next.edges.length).toBe(1)
    expect(next.edges[0]?.id).toBe('other')
  })
})
