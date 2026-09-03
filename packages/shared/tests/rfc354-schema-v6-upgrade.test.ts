// RFC-354 — schema v5 → v6: every node-level PortRef becomes an edge.
//
// Locks (design D10):
//   • review `inputSource` → the one inbound edge to `__review_input__` (added
//     only when the canvas' lock-step edge is missing — hand-written YAML);
//   • output `ports[].bind` → one inbound edge per port;
//   • loop `outputBindings[]` → `wrapper-output` edges; `exitCondition.nodeId`
//     is dropped and `portName` re-pointed at the loop's OWN return port —
//     a body port that had no binding is promoted under its own name
//     (suffixed when that return name is already taken);
//   • fanout `inputs[]` → `shardSourcePort`;
//   • idempotent: a v6 document passes through byte-identical; a v5 document
//     upgraded twice equals once; edge ids never collide with existing ones.

import { describe, expect, test } from 'bun:test'
import {
  REVIEW_INPUT_PORT_NAME,
  WORKFLOW_SCHEMA_VERSION,
  migrateWorkflowDefinitionToLatest,
  migrateWorkflowDefinitionV5ToV6,
  type WorkflowDefinition,
  type WorkflowNode,
} from '../src'

function def(nodes: Record<string, unknown>[], edges: WorkflowDefinition['edges'] = []) {
  return {
    $schema_version: 5,
    inputs: [],
    nodes: nodes as unknown as WorkflowNode[],
    edges,
  } as WorkflowDefinition
}

function nodeById(d: WorkflowDefinition, id: string): Record<string, unknown> {
  const node = d.nodes.find((n) => n.id === id)
  if (node === undefined) throw new Error(`node ${id} missing`)
  return node as unknown as Record<string, unknown>
}

describe('RFC-354 — v5 → v6 upgrader', () => {
  test('WORKFLOW_SCHEMA_VERSION is 6 and the cascade lands there', () => {
    expect(WORKFLOW_SCHEMA_VERSION).toBe(6)
    const upgraded = migrateWorkflowDefinitionToLatest(def([]))
    expect(upgraded.$schema_version).toBe(6)
  })

  test('review: inputSource becomes the __review_input__ edge, added only when missing', () => {
    const withEdge = def(
      [
        { id: 'writer', kind: 'agent-single', agentName: 'w' },
        { id: 'rv', kind: 'review', inputSource: { nodeId: 'writer', portName: 'doc' } },
      ],
      [
        {
          id: 'e1',
          source: { nodeId: 'writer', portName: 'doc' },
          target: { nodeId: 'rv', portName: REVIEW_INPUT_PORT_NAME },
        },
      ],
    )
    const upgraded = migrateWorkflowDefinitionV5ToV6(withEdge)
    expect(upgraded.edges).toEqual(withEdge.edges)
    expect('inputSource' in nodeById(upgraded, 'rv')).toBe(false)

    const handWritten = def([
      { id: 'writer', kind: 'agent-single', agentName: 'w' },
      { id: 'rv', kind: 'review', inputSource: { nodeId: 'writer', portName: 'doc' } },
    ])
    const fixed = migrateWorkflowDefinitionV5ToV6(handWritten)
    expect(fixed.edges).toEqual([
      {
        id: 'writer_doc_to_rv___review_input__',
        source: { nodeId: 'writer', portName: 'doc' },
        target: { nodeId: 'rv', portName: REVIEW_INPUT_PORT_NAME },
      },
    ])
  })

  test('review: an empty (unwired) inputSource upgrades to no edge at all', () => {
    const unwired = def([{ id: 'rv', kind: 'review', inputSource: { nodeId: '', portName: '' } }])
    const upgraded = migrateWorkflowDefinitionV5ToV6(unwired)
    expect(upgraded.edges).toEqual([])
    expect('inputSource' in nodeById(upgraded, 'rv')).toBe(false)
  })

  test('output: ports[].bind become inbound edges; the node keeps no ports field', () => {
    const d = def(
      [
        { id: 'a', kind: 'agent-single', agentName: 'a' },
        {
          id: 'out',
          kind: 'output',
          ports: [
            { name: 'report', bind: { nodeId: 'a', portName: 'result' } },
            { name: 'notes', bind: { nodeId: 'a', portName: 'notes' } },
          ],
        },
      ],
      [
        {
          id: 'existing',
          source: { nodeId: 'a', portName: 'result' },
          target: { nodeId: 'out', portName: 'report' },
        },
      ],
    )
    const upgraded = migrateWorkflowDefinitionV5ToV6(d)
    expect(upgraded.edges.map((e) => e.id)).toEqual(['existing', 'a_notes_to_out_notes'])
    expect('ports' in nodeById(upgraded, 'out')).toBe(false)
  })

  test('loop: bindings become wrapper-output edges; the exit condition targets the loop return port', () => {
    const d = def([
      { id: 'worker', kind: 'agent-single', agentName: 'w' },
      { id: 'checker', kind: 'agent-single', agentName: 'c' },
      {
        id: 'loop',
        kind: 'wrapper-loop',
        nodeIds: ['worker', 'checker'],
        maxIterations: 3,
        exitCondition: {
          kind: 'port-equals',
          nodeId: 'checker',
          portName: 'verdict',
          value: 'STOP',
        },
        outputBindings: [{ name: 'final', bind: { nodeId: 'checker', portName: 'verdict' } }],
      },
    ])
    const upgraded = migrateWorkflowDefinitionV5ToV6(d)
    expect(upgraded.edges).toEqual([
      {
        id: 'checker_verdict_to_loop_final',
        source: { nodeId: 'checker', portName: 'verdict' },
        target: { nodeId: 'loop', portName: 'final' },
        boundary: 'wrapper-output',
      },
    ])
    const loop = nodeById(upgraded, 'loop')
    expect(loop.exitCondition).toEqual({ kind: 'port-equals', portName: 'final', value: 'STOP' })
    expect('outputBindings' in loop).toBe(false)
    expect(loop.maxIterations).toBe(3)
  })

  test('loop: an exit port with no binding is promoted under its own name (suffixed on a clash)', () => {
    const d = def([
      { id: 'worker', kind: 'agent-single', agentName: 'w' },
      { id: 'checker', kind: 'agent-single', agentName: 'c' },
      {
        id: 'loop',
        kind: 'wrapper-loop',
        nodeIds: ['worker', 'checker'],
        maxIterations: 2,
        // exit reads checker.verdict, but the only binding named `verdict` promotes worker.verdict
        exitCondition: { kind: 'port-empty', nodeId: 'checker', portName: 'verdict' },
        outputBindings: [{ name: 'verdict', bind: { nodeId: 'worker', portName: 'verdict' } }],
      },
    ])
    const upgraded = migrateWorkflowDefinitionV5ToV6(d)
    expect(upgraded.edges.map((e) => [e.source.nodeId, e.target.portName, e.boundary])).toEqual([
      ['worker', 'verdict', 'wrapper-output'],
      ['checker', 'verdict_2', 'wrapper-output'],
    ])
    expect(nodeById(upgraded, 'loop').exitCondition).toEqual({
      kind: 'port-empty',
      portName: 'verdict_2',
    })
  })

  test('fanout: inputs[] collapse to shardSourcePort', () => {
    const d = def([
      { id: 'a', kind: 'agent-single', agentName: 'a' },
      {
        id: 'fan',
        kind: 'wrapper-fanout',
        nodeIds: ['a'],
        inputs: [
          { name: 'docs', kind: 'list<path<md>>', isShardSource: true },
          { name: 'style', kind: 'string' },
        ],
      },
    ])
    const fan = nodeById(migrateWorkflowDefinitionV5ToV6(d), 'fan')
    expect(fan.shardSourcePort).toBe('docs')
    expect('inputs' in fan).toBe(false)
  })

  test('idempotent: upgrading twice equals once; a v6 document is untouched by the cascade', () => {
    const d = def(
      [
        { id: 'writer', kind: 'agent-single', agentName: 'w' },
        { id: 'rv', kind: 'review', inputSource: { nodeId: 'writer', portName: 'doc' } },
        {
          id: 'loop',
          kind: 'wrapper-loop',
          nodeIds: ['writer'],
          maxIterations: 1,
          exitCondition: { kind: 'port-empty', nodeId: 'writer', portName: 'doc' },
          outputBindings: [],
        },
      ],
      [
        // an id the allocator would otherwise pick
        {
          id: 'writer_doc_to_rv___review_input__',
          source: { nodeId: 'writer', portName: 'other' },
          target: { nodeId: 'rv', portName: 'x' },
        },
      ],
    )
    const once = migrateWorkflowDefinitionToLatest(d)
    const twice = migrateWorkflowDefinitionToLatest(once)
    expect(twice).toEqual(once)
    expect(once.$schema_version).toBe(6)
    const ids = once.edges.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain('writer_doc_to_rv___review_input___2')
  })
})
