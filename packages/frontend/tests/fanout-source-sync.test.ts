// RFC-015 — pure-function locks for the agent-multi `sourcePort` drag-set
// helpers in `components/canvas/fanoutSourceSync.ts`. The integration test
// (canvas-fanout-source-port-drag.test.tsx) exercises the same helpers
// through WorkflowCanvas; these tests stay closer to the wire so we can
// pin invariants — top-handle fast-path, single-source replacement,
// ref-equality short-circuits, cascade clear on node removal, and the
// drop-validity guards — without React in the picture.
//
// If a case here goes red, check fanoutSourceSync.ts FIRST: the integration
// test is layered on top.

import type { Connection } from '@xyflow/react'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import { describe, expect, test } from 'vitest'
import {
  MULTI_SOURCE_PORT_HANDLE_ID,
  SOURCE_PORT_EDGE_ID_PREFIX,
  applySourcePortConnection,
  buildSourcePortDisplayEdges,
  clearSourcePortOnNodeRemoved,
  isValidSourcePortConnection,
} from '../src/components/canvas/fanoutSourceSync'

function makeDef(extra: Partial<WorkflowDefinition>): WorkflowDefinition {
  return {
    $schema_version: 2,
    inputs: [],
    nodes: [],
    edges: [],
    ...extra,
  }
}

function agent(id: string): WorkflowNode {
  return {
    id,
    kind: 'agent-single',
    agentName: 'stub',
  } as unknown as WorkflowNode
}

function multi(
  id: string,
  sourcePort: { nodeId: string; portName: string } = { nodeId: '', portName: '' },
): WorkflowNode {
  return {
    id,
    kind: 'agent-multi',
    agentName: 'stub',
    sourcePort,
  } as unknown as WorkflowNode
}

function review(id: string): WorkflowNode {
  return {
    id,
    kind: 'review',
    inputSource: { nodeId: '', portName: '' },
  } as unknown as WorkflowNode
}

function topHandleConn(source: string, sourceHandle: string, target: string): Connection {
  return {
    source,
    sourceHandle,
    target,
    targetHandle: MULTI_SOURCE_PORT_HANDLE_ID,
  }
}

function readSourcePort(def: WorkflowDefinition, id: string): { nodeId: string; portName: string } {
  const n = def.nodes.find((x) => x.id === id)!
  return (n as unknown as { sourcePort: { nodeId: string; portName: string } }).sourcePort
}

// ---------------------------------------------------------------------------
// applySourcePortConnection
// ---------------------------------------------------------------------------

describe('applySourcePortConnection', () => {
  test('top-handle drop on agent-multi → writes sourcePort, new def reference', () => {
    const def = makeDef({ nodes: [agent('designer'), multi('audit')] })
    const next = applySourcePortConnection(
      def,
      topHandleConn('designer', 'markdown_design', 'audit'),
    )
    expect(next).not.toBe(def)
    expect(readSourcePort(next, 'audit')).toEqual({
      nodeId: 'designer',
      portName: 'markdown_design',
    })
  })

  test('top-handle drop on agent-single → returns def by reference (no field)', () => {
    const def = makeDef({ nodes: [agent('designer'), agent('worker')] })
    const next = applySourcePortConnection(def, topHandleConn('designer', 'out', 'worker'))
    expect(next).toBe(def)
  })

  test('top-handle drop on review → returns def by reference', () => {
    const def = makeDef({ nodes: [agent('designer'), review('r')] })
    const next = applySourcePortConnection(def, topHandleConn('designer', 'out', 'r'))
    expect(next).toBe(def)
  })

  test('drop on catch-all (__inbound__) → returns def by reference, never touches sourcePort', () => {
    const def = makeDef({ nodes: [agent('designer'), multi('audit')] })
    const conn: Connection = {
      source: 'designer',
      sourceHandle: 'out',
      target: 'audit',
      targetHandle: '__inbound__',
    }
    const next = applySourcePortConnection(def, conn)
    expect(next).toBe(def)
  })

  test('second top-handle drop with different source → replaces sourcePort silently', () => {
    const def0 = makeDef({ nodes: [agent('designer'), agent('auditorA'), multi('audit')] })
    const def1 = applySourcePortConnection(
      def0,
      topHandleConn('designer', 'markdown_design', 'audit'),
    )
    const def2 = applySourcePortConnection(
      def1,
      topHandleConn('auditorA', 'markdown_summary', 'audit'),
    )
    expect(readSourcePort(def2, 'audit')).toEqual({
      nodeId: 'auditorA',
      portName: 'markdown_summary',
    })
  })

  test('top-handle drop with identical source/port → returns def by reference (ref-equality)', () => {
    const def = makeDef({
      nodes: [
        agent('designer'),
        multi('audit', { nodeId: 'designer', portName: 'markdown_design' }),
      ],
    })
    const next = applySourcePortConnection(
      def,
      topHandleConn('designer', 'markdown_design', 'audit'),
    )
    expect(next).toBe(def)
  })
})

// ---------------------------------------------------------------------------
// clearSourcePortOnNodeRemoved
// ---------------------------------------------------------------------------

describe('clearSourcePortOnNodeRemoved', () => {
  test('source node removed → fanout sourcePort reset to empty', () => {
    const def = makeDef({
      nodes: [
        agent('designer'),
        multi('audit', { nodeId: 'designer', portName: 'markdown_design' }),
      ],
    })
    const next = clearSourcePortOnNodeRemoved(def, ['designer'])
    expect(next).not.toBe(def)
    expect(readSourcePort(next, 'audit')).toEqual({ nodeId: '', portName: '' })
  })

  test('unrelated node removed → returns def by reference', () => {
    const def = makeDef({
      nodes: [
        agent('designer'),
        agent('lonely'),
        multi('audit', { nodeId: 'designer', portName: 'markdown_design' }),
      ],
    })
    const next = clearSourcePortOnNodeRemoved(def, ['lonely'])
    expect(next).toBe(def)
  })

  test('multiple fanouts referencing different sources → only affected ones reset', () => {
    const def = makeDef({
      nodes: [
        agent('designer'),
        agent('auditorA'),
        multi('mA', { nodeId: 'designer', portName: 'p1' }),
        multi('mB', { nodeId: 'auditorA', portName: 'p2' }),
      ],
    })
    const next = clearSourcePortOnNodeRemoved(def, ['designer'])
    expect(readSourcePort(next, 'mA')).toEqual({ nodeId: '', portName: '' })
    expect(readSourcePort(next, 'mB')).toEqual({ nodeId: 'auditorA', portName: 'p2' })
  })

  test('empty removed list → returns def by reference', () => {
    const def = makeDef({
      nodes: [multi('audit', { nodeId: 'designer', portName: 'p' })],
    })
    expect(clearSourcePortOnNodeRemoved(def, [])).toBe(def)
  })
})

// ---------------------------------------------------------------------------
// isValidSourcePortConnection
// ---------------------------------------------------------------------------

describe('isValidSourcePortConnection', () => {
  test('non-top-handle drop → always true (pass-through)', () => {
    const def = makeDef({ nodes: [agent('designer'), multi('audit')] })
    expect(
      isValidSourcePortConnection(def, {
        source: 'designer',
        target: 'audit',
        targetHandle: '__inbound__',
      }),
    ).toBe(true)
  })

  test('self-loop on fanout via top handle → false', () => {
    const def = makeDef({ nodes: [multi('audit')] })
    expect(
      isValidSourcePortConnection(def, {
        source: 'audit',
        target: 'audit',
        targetHandle: MULTI_SOURCE_PORT_HANDLE_ID,
      }),
    ).toBe(false)
  })

  test('top-handle drop on agent-single target → false', () => {
    const def = makeDef({ nodes: [agent('designer'), agent('worker')] })
    expect(
      isValidSourcePortConnection(def, {
        source: 'designer',
        target: 'worker',
        targetHandle: MULTI_SOURCE_PORT_HANDLE_ID,
      }),
    ).toBe(false)
  })

  test('top-handle drop, source node missing → false', () => {
    const def = makeDef({ nodes: [multi('audit')] })
    expect(
      isValidSourcePortConnection(def, {
        source: 'ghost',
        target: 'audit',
        targetHandle: MULTI_SOURCE_PORT_HANDLE_ID,
      }),
    ).toBe(false)
  })

  test('top-handle drop with valid source + fanout target → true', () => {
    const def = makeDef({ nodes: [agent('designer'), multi('audit')] })
    expect(
      isValidSourcePortConnection(def, {
        source: 'designer',
        target: 'audit',
        targetHandle: MULTI_SOURCE_PORT_HANDLE_ID,
      }),
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// buildSourcePortDisplayEdges — render-only synthetic edges so the user
// sees a visible line from the upstream port to the agent-multi node's
// top handle. NOT persisted in definition.edges[].
// ---------------------------------------------------------------------------

describe('buildSourcePortDisplayEdges', () => {
  test('empty when no agent-multi nodes', () => {
    const def = makeDef({ nodes: [agent('designer')] })
    expect(buildSourcePortDisplayEdges(def)).toEqual([])
  })

  test('empty when agent-multi has unset sourcePort', () => {
    const def = makeDef({ nodes: [agent('designer'), multi('audit')] })
    expect(buildSourcePortDisplayEdges(def)).toEqual([])
  })

  test('emits one synthetic edge per fanout with set + resolvable sourcePort', () => {
    const def = makeDef({
      nodes: [
        agent('designer'),
        multi('audit', { nodeId: 'designer', portName: 'markdown_design' }),
      ],
    })
    const result = buildSourcePortDisplayEdges(def)
    expect(result).toHaveLength(1)
    const edge = result[0]!
    expect(edge.id).toBe(`${SOURCE_PORT_EDGE_ID_PREFIX}audit`)
    expect(edge.source).toBe('designer')
    expect(edge.sourceHandle).toBe('markdown_design')
    expect(edge.target).toBe('audit')
    expect(edge.targetHandle).toBe(MULTI_SOURCE_PORT_HANDLE_ID)
    expect(edge.selectable).toBe(false)
    expect(edge.deletable).toBe(false)
    expect(edge.data).toEqual({ synthetic: 'sourcePort' })
  })

  test('skips fanouts whose sourcePort references a deleted node', () => {
    const def = makeDef({
      nodes: [multi('audit', { nodeId: 'ghost', portName: 'p' })],
    })
    expect(buildSourcePortDisplayEdges(def)).toEqual([])
  })

  test('skips fanouts whose sourcePort has empty portName', () => {
    const def = makeDef({
      nodes: [agent('designer'), multi('audit', { nodeId: 'designer', portName: '' })],
    })
    expect(buildSourcePortDisplayEdges(def)).toEqual([])
  })

  test('synthetic edge id prefix sits outside `definition.edges[]` id space', () => {
    const def = makeDef({
      nodes: [
        agent('designer'),
        multi('audit', { nodeId: 'designer', portName: 'markdown_design' }),
      ],
    })
    const result = buildSourcePortDisplayEdges(def)
    // toDefinition's liveById filter would never match a synthetic id against
    // a real edge id; lock the prefix so this contract stays.
    expect(result[0]?.id.startsWith(SOURCE_PORT_EDGE_ID_PREFIX)).toBe(true)
  })
})
