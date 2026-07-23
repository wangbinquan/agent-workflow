// RFC-167 — dynamic workflow generation protocol: envelope + conversion.
//
// (The separate `DynamicWorkflowSpace` resource schemas were reverted in the
// 2026-07-11 pivot — dynamic workflow became a workgroup mode. Only the
// generation protocol survives, reused by the workgroup dynamic-mode engine.)
//
// Locks:
//  1. DwGeneratedWorkflowSchema: node shape (agentToken, RFC-223 PR-3b), inputs
//     default [], edges default [].
//  2. dwGeneratedToWorkflowDef conversion matrix: node→agent-single, the SINGLE
//     token→agentId conversion (each node stamps the frozen agentId + display
//     agentName, never the token), inputs→edges, top-level edges, dedup of
//     overlapping inputs/edges, branch / parallel / multi-same-agent,
//     deterministic edge ids, NO synthetic IO nodes.
//  3. RFC-223 PR-3b: an unknown token yields an id-less node + is reported in
//     `unknownTokens` (the token is never written as a node identity).

import { describe, expect, test } from 'bun:test'
import {
  DW_VALIDATION_CODES,
  DwGeneratedWorkflowSchema,
  dwGeneratedToWorkflowDef,
  dwMemberToken,
  type DwTokenMap,
} from '../src'

/** A frozen token→agent map — the LLM only ever sees/emits the `member#N` keys. */
const TOKENS: DwTokenMap = new Map([
  ['member#1', { agentId: 'ID_CODER', agentName: 'coder' }],
  ['member#2', { agentId: 'ID_AUDITOR', agentName: 'auditor' }],
])

describe('dwMemberToken', () => {
  test('is a 1-based opaque `member#N` token', () => {
    expect(dwMemberToken(0)).toBe('member#1')
    expect(dwMemberToken(1)).toBe('member#2')
    // never a real name/id
    expect(dwMemberToken(0)).not.toContain('coder')
    expect(dwMemberToken(0)).not.toContain('ID_')
  })
})

describe('DwGeneratedWorkflowSchema', () => {
  test('node inputs + top-level edges default to []', () => {
    const parsed = DwGeneratedWorkflowSchema.parse({
      nodes: [{ id: 'n1', agentToken: 'member#1', promptTemplate: 'do it' }],
    })
    expect(parsed.nodes[0]?.inputs).toEqual([])
    expect(parsed.nodes[0]?.agentToken).toBe('member#1')
    expect(parsed.edges).toEqual([])
  })

  test('rejects an empty node id / agentToken', () => {
    expect(() =>
      DwGeneratedWorkflowSchema.parse({
        nodes: [{ id: '', agentToken: 'member#1', promptTemplate: '' }],
      }),
    ).toThrow()
    expect(() =>
      DwGeneratedWorkflowSchema.parse({
        nodes: [{ id: 'n1', agentToken: '', promptTemplate: '' }],
      }),
    ).toThrow()
  })
})

describe('dwGeneratedToWorkflowDef — single token→agentId conversion point', () => {
  test('single node → one id-canonical agent-single node, no edges, no IO nodes', () => {
    const { def, unknownTokens } = dwGeneratedToWorkflowDef(
      {
        nodes: [{ id: 'n1', agentToken: 'member#1', promptTemplate: 'goal baked in', inputs: [] }],
        edges: [],
      },
      TOKENS,
    )
    expect(unknownTokens).toEqual([])
    expect(def.$schema_version).toBe(4)
    expect(def.inputs).toEqual([])
    // the token was converted to the frozen agentId (+ display name); the token
    // itself is NOT written anywhere on the node.
    expect(def.nodes).toEqual([
      {
        id: 'n1',
        kind: 'agent-single',
        promptTemplate: 'goal baked in',
        agentId: 'ID_CODER',
        agentName: 'coder',
      },
    ])
    expect(JSON.stringify(def)).not.toContain('member#1')
    expect(def.edges).toEqual([])
    // no synthetic input/output IO nodes
    expect(def.nodes.every((n) => n.kind === 'agent-single')).toBe(true)
  })

  test('an unknown token → id-less node + reported in unknownTokens (never stored as identity)', () => {
    const { def, unknownTokens } = dwGeneratedToWorkflowDef(
      {
        nodes: [{ id: 'n1', agentToken: 'member#99', promptTemplate: 'x', inputs: [] }],
        edges: [],
      },
      TOKENS,
    )
    expect(unknownTokens).toEqual(['member#99'])
    const node = def.nodes[0] as Record<string, unknown>
    expect(node.agentId).toBeUndefined()
    // the raw token is never leaked onto the node as an agent identity
    expect(JSON.stringify(def)).not.toContain('member#99')
  })

  test('node.inputs become edges (chain)', () => {
    const { def } = dwGeneratedToWorkflowDef(
      {
        nodes: [
          { id: 'a', agentToken: 'member#1', promptTemplate: 'write', inputs: [] },
          {
            id: 'b',
            agentToken: 'member#2',
            promptTemplate: 'review {{patch}}',
            inputs: [{ port: 'patch', from: { nodeId: 'a', portName: 'patch' } }],
          },
        ],
        edges: [],
      },
      TOKENS,
    )
    expect(def.edges).toEqual([
      {
        id: 'dwe_a.patch__b.patch',
        source: { nodeId: 'a', portName: 'patch' },
        target: { nodeId: 'b', portName: 'patch' },
      },
    ])
  })

  test('branch: two nodes consuming the same upstream port → two edges', () => {
    const { def } = dwGeneratedToWorkflowDef(
      {
        nodes: [
          { id: 'a', agentToken: 'member#1', promptTemplate: 'w', inputs: [] },
          {
            id: 'b',
            agentToken: 'member#2',
            promptTemplate: '{{p}}',
            inputs: [{ port: 'p', from: { nodeId: 'a', portName: 'patch' } }],
          },
          {
            id: 'c',
            agentToken: 'member#2',
            promptTemplate: '{{p}}',
            inputs: [{ port: 'p', from: { nodeId: 'a', portName: 'patch' } }],
          },
        ],
        edges: [],
      },
      TOKENS,
    )
    expect(def.edges.map((e) => e.target.nodeId).sort()).toEqual(['b', 'c'])
  })

  test('parallel independent nodes → no edges; same token twice reuses one agent', () => {
    const { def } = dwGeneratedToWorkflowDef(
      {
        nodes: [
          { id: 'a', agentToken: 'member#1', promptTemplate: 'x', inputs: [] },
          { id: 'b', agentToken: 'member#1', promptTemplate: 'y', inputs: [] },
        ],
        edges: [],
      },
      TOKENS,
    )
    expect(def.edges).toEqual([])
    // same token used twice is allowed (a pool agent is reusable) → same agentId
    expect(def.nodes.map((n) => (n as Record<string, unknown>).agentId)).toEqual([
      'ID_CODER',
      'ID_CODER',
    ])
  })

  test('overlapping node.inputs + top-level edge is de-duped to one edge', () => {
    const { def } = dwGeneratedToWorkflowDef(
      {
        nodes: [
          { id: 'a', agentToken: 'member#1', promptTemplate: 'x', inputs: [] },
          {
            id: 'b',
            agentToken: 'member#2',
            promptTemplate: '{{p}}',
            inputs: [{ port: 'p', from: { nodeId: 'a', portName: 'out' } }],
          },
        ],
        // same connection restated explicitly
        edges: [
          { source: { nodeId: 'a', portName: 'out' }, target: { nodeId: 'b', portName: 'p' } },
        ],
      },
      TOKENS,
    )
    expect(def.edges).toHaveLength(1)
    expect(def.edges[0]?.id).toBe('dwe_a.out__b.p')
  })

  test('top-level edges alone are honored', () => {
    const { def } = dwGeneratedToWorkflowDef(
      {
        nodes: [
          { id: 'a', agentToken: 'member#1', promptTemplate: 'x', inputs: [] },
          { id: 'b', agentToken: 'member#2', promptTemplate: '{{r}}', inputs: [] },
        ],
        edges: [{ source: { nodeId: 'a', portName: 'r' }, target: { nodeId: 'b', portName: 'r' } }],
      },
      TOKENS,
    )
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
