// RFC-167 T1 — dynamic workflow space schemas + generation-envelope conversion.
//
// Locks:
//  1. DynamicWorkflowSpace / Create / Update schemas: name slug rule, agentPool
//     default [], quick-create (name only), strict update.
//  2. DwGeneratedWorkflowSchema: node shape, inputs default [], edges default [].
//  3. dwGeneratedToWorkflowDef conversion matrix: node→agent-single, inputs→edges,
//     top-level edges, dedup of overlapping inputs/edges, branch / parallel /
//     multi-same-agent, deterministic edge ids, NO synthetic IO nodes.

import { describe, expect, test } from 'bun:test'
import {
  CreateDynamicWorkflowSpaceSchema,
  DW_VALIDATION_CODES,
  DwGeneratedWorkflowSchema,
  DynamicWorkflowSpaceSchema,
  UpdateDynamicWorkflowSpaceSchema,
  dwGeneratedToWorkflowDef,
} from '../src'

describe('DynamicWorkflowSpace schemas', () => {
  const base = {
    id: 'dws_01',
    name: 'my-space',
    description: 'a space',
    agentPool: ['coder', 'auditor'],
    schemaVersion: 1,
    createdAt: 0,
    updatedAt: 0,
  }

  test('full resource parses', () => {
    expect(DynamicWorkflowSpaceSchema.parse(base).agentPool).toEqual(['coder', 'auditor'])
  })

  test('rejects a non-slug name', () => {
    expect(() => DynamicWorkflowSpaceSchema.parse({ ...base, name: 'Bad Name' })).toThrow()
  })

  test('create fills description + agentPool defaults (quick create = name only)', () => {
    const parsed = CreateDynamicWorkflowSpaceSchema.parse({ name: 'quick' })
    expect(parsed).toEqual({ name: 'quick', description: '', agentPool: [] })
  })

  test('create rejects a pool entry that is not a valid agent name', () => {
    expect(() =>
      CreateDynamicWorkflowSpaceSchema.parse({ name: 'x', agentPool: ['Bad Agent'] }),
    ).toThrow()
  })

  test('update is strict (rejects unknown keys) + partial', () => {
    expect(UpdateDynamicWorkflowSpaceSchema.parse({ agentPool: ['a'] })).toEqual({
      agentPool: ['a'],
    })
    expect(() => UpdateDynamicWorkflowSpaceSchema.parse({ name: 'renamed' })).toThrow()
  })
})

describe('DwGeneratedWorkflowSchema', () => {
  test('node inputs + top-level edges default to []', () => {
    const parsed = DwGeneratedWorkflowSchema.parse({
      nodes: [{ id: 'n1', agentName: 'coder', promptTemplate: 'do it' }],
    })
    expect(parsed.nodes[0]?.inputs).toEqual([])
    expect(parsed.edges).toEqual([])
  })

  test('rejects an empty node id / agentName', () => {
    expect(() =>
      DwGeneratedWorkflowSchema.parse({ nodes: [{ id: '', agentName: 'c', promptTemplate: '' }] }),
    ).toThrow()
  })
})

describe('dwGeneratedToWorkflowDef — conversion matrix', () => {
  test('single node → one agent-single node, no edges, no IO nodes', () => {
    const def = dwGeneratedToWorkflowDef({
      nodes: [{ id: 'n1', agentName: 'coder', promptTemplate: 'goal baked in', inputs: [] }],
      edges: [],
    })
    expect(def.$schema_version).toBe(4)
    expect(def.inputs).toEqual([])
    expect(def.nodes).toEqual([
      { id: 'n1', kind: 'agent-single', agentName: 'coder', promptTemplate: 'goal baked in' },
    ])
    expect(def.edges).toEqual([])
    // no synthetic input/output IO nodes
    expect(def.nodes.every((n) => n.kind === 'agent-single')).toBe(true)
  })

  test('node.inputs become edges (chain)', () => {
    const def = dwGeneratedToWorkflowDef({
      nodes: [
        { id: 'a', agentName: 'coder', promptTemplate: 'write', inputs: [] },
        {
          id: 'b',
          agentName: 'auditor',
          promptTemplate: 'review {{patch}}',
          inputs: [{ port: 'patch', from: { nodeId: 'a', portName: 'patch' } }],
        },
      ],
      edges: [],
    })
    expect(def.edges).toEqual([
      {
        id: 'dwe_a.patch__b.patch',
        source: { nodeId: 'a', portName: 'patch' },
        target: { nodeId: 'b', portName: 'patch' },
      },
    ])
  })

  test('branch: two nodes consuming the same upstream port → two edges', () => {
    const def = dwGeneratedToWorkflowDef({
      nodes: [
        { id: 'a', agentName: 'coder', promptTemplate: 'w', inputs: [] },
        {
          id: 'b',
          agentName: 'auditor',
          promptTemplate: '{{p}}',
          inputs: [{ port: 'p', from: { nodeId: 'a', portName: 'patch' } }],
        },
        {
          id: 'c',
          agentName: 'auditor',
          promptTemplate: '{{p}}',
          inputs: [{ port: 'p', from: { nodeId: 'a', portName: 'patch' } }],
        },
      ],
      edges: [],
    })
    expect(def.edges.map((e) => e.target.nodeId).sort()).toEqual(['b', 'c'])
  })

  test('parallel independent nodes → no edges', () => {
    const def = dwGeneratedToWorkflowDef({
      nodes: [
        { id: 'a', agentName: 'coder', promptTemplate: 'x', inputs: [] },
        { id: 'b', agentName: 'coder', promptTemplate: 'y', inputs: [] },
      ],
      edges: [],
    })
    expect(def.edges).toEqual([])
    // same agent used twice is allowed (a pool agent is reusable)
    expect(def.nodes.map((n) => n.agentName)).toEqual(['coder', 'coder'])
  })

  test('overlapping node.inputs + top-level edge is de-duped to one edge', () => {
    const def = dwGeneratedToWorkflowDef({
      nodes: [
        { id: 'a', agentName: 'coder', promptTemplate: 'x', inputs: [] },
        {
          id: 'b',
          agentName: 'auditor',
          promptTemplate: '{{p}}',
          inputs: [{ port: 'p', from: { nodeId: 'a', portName: 'out' } }],
        },
      ],
      // same connection restated explicitly
      edges: [{ source: { nodeId: 'a', portName: 'out' }, target: { nodeId: 'b', portName: 'p' } }],
    })
    expect(def.edges).toHaveLength(1)
    expect(def.edges[0]?.id).toBe('dwe_a.out__b.p')
  })

  test('top-level edges alone are honored', () => {
    const def = dwGeneratedToWorkflowDef({
      nodes: [
        { id: 'a', agentName: 'coder', promptTemplate: 'x', inputs: [] },
        { id: 'b', agentName: 'auditor', promptTemplate: '{{r}}', inputs: [] },
      ],
      edges: [{ source: { nodeId: 'a', portName: 'r' }, target: { nodeId: 'b', portName: 'r' } }],
    })
    expect(def.edges).toHaveLength(1)
    expect(def.edges[0]?.source).toEqual({ nodeId: 'a', portName: 'r' })
  })
})

describe('DW_VALIDATION_CODES', () => {
  test('stable kebab-case codes', () => {
    expect(DW_VALIDATION_CODES).toEqual({
      nodeKindForbidden: 'dw-node-kind-forbidden',
      agentOutsidePool: 'dw-agent-outside-pool',
      empty: 'dw-empty',
      orphanNode: 'dw-orphan-node',
    })
  })
})
