// RFC-007 → RFC-354 (schema v6) — pure-function locks for the review / output
// connection helpers in `components/canvas/connectionSync.ts`.
//
// Until schema v6 these helpers double-wrote `review.inputSource` and
// `output.ports[].bind`. Those fields are gone: the review input IS its one
// `__review_input__` edge and an output node's ports ARE its inbound edges.
// What is locked here is the edge-only shape — single-input replacement for
// review, catch-all `_2`/`_3` disambiguation for output, ref-equality
// short-circuits — plus a source-level guard that no PortRef field can ever
// be written from this module again.
//
// If a case here goes red, check connectionSync.ts FIRST: the integration
// test (canvas-review-output-drag.test.tsx) is layered on top.

import type { WorkflowDefinition, WorkflowEdge, WorkflowNode } from '@agent-workflow/shared'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  applyConnectionForReviewOutput,
  inboundPortNames,
  REVIEW_INPUT_HANDLE_ID,
  uniquePortName,
} from '../src/components/canvas/connectionSync'

function makeDef(extra: Partial<WorkflowDefinition>): WorkflowDefinition {
  return {
    $schema_version: 6,
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

function review(id: string): WorkflowNode {
  return { id, kind: 'review' } as unknown as WorkflowNode
}

function output(id: string): WorkflowNode {
  return { id, kind: 'output' } as unknown as WorkflowNode
}

function nodeRecord(def: WorkflowDefinition, id: string): Record<string, unknown> {
  return def.nodes.find((n) => n.id === id) as unknown as Record<string, unknown>
}

// ---------------------------------------------------------------------------
// applyConnectionForReviewOutput
// ---------------------------------------------------------------------------

describe('applyConnectionForReviewOutput', () => {
  test('target is agent → returns def unchanged (only edges array mutated by caller)', () => {
    const edge: WorkflowEdge = {
      id: 'e1',
      source: { nodeId: 'a', portName: 'out' },
      target: { nodeId: 'b', portName: 'in' },
    }
    const def = makeDef({ nodes: [agent('a'), agent('b')], edges: [edge] })
    expect(applyConnectionForReviewOutput(def, edge)).toBe(def)
  })

  test('target is review with no prior edge → the edge stands alone, no node field is written', () => {
    const edge: WorkflowEdge = {
      id: 'e1',
      source: { nodeId: 'a', portName: 'design' },
      target: { nodeId: 'r', portName: REVIEW_INPUT_HANDLE_ID },
    }
    const def = makeDef({ nodes: [agent('a'), review('r')], edges: [edge] })
    const next = applyConnectionForReviewOutput(def, edge)
    expect(next).toBe(def)
    expect('inputSource' in nodeRecord(next, 'r')).toBe(false)
  })

  test('target is review with existing inbound edge → old edge dropped, new kept', () => {
    const oldEdge: WorkflowEdge = {
      id: 'old',
      source: { nodeId: 'a', portName: 'design' },
      target: { nodeId: 'r', portName: REVIEW_INPUT_HANDLE_ID },
    }
    const newEdge: WorkflowEdge = {
      id: 'new',
      source: { nodeId: 'b', portName: 'spec' },
      target: { nodeId: 'r', portName: REVIEW_INPUT_HANDLE_ID },
    }
    const def = makeDef({
      nodes: [agent('a'), agent('b'), review('r')],
      edges: [oldEdge, newEdge],
    })
    const next = applyConnectionForReviewOutput(def, newEdge)
    expect(next.edges).toEqual([newEdge])
    expect('inputSource' in nodeRecord(next, 'r')).toBe(false)
  })

  test('target is output, drop on named handle → the edge occupying that port is replaced', () => {
    const prior: WorkflowEdge = {
      id: 'prior',
      source: { nodeId: 'k', portName: 'x' },
      target: { nodeId: 'o', portName: 'final_doc' },
    }
    const other: WorkflowEdge = {
      id: 'other',
      source: { nodeId: 'k', portName: 'y' },
      target: { nodeId: 'o', portName: 'audit_report' },
    }
    const edge: WorkflowEdge = {
      id: 'e1',
      source: { nodeId: 'a', portName: 'design' },
      target: { nodeId: 'o', portName: 'final_doc' },
    }
    const def = makeDef({
      nodes: [agent('a'), agent('k'), output('o')],
      edges: [prior, other, edge],
    })
    const next = applyConnectionForReviewOutput(def, edge)
    expect(next.edges).toEqual([other, edge])
    expect('ports' in nodeRecord(next, 'o')).toBe(false)
  })

  test('target is output, drop on catch-all of empty output → the edge names the port verbatim', () => {
    const edge: WorkflowEdge = {
      id: 'e1',
      source: { nodeId: 'a', portName: 'audit_md' },
      target: { nodeId: 'o', portName: 'audit_md' },
    }
    const def = makeDef({ nodes: [agent('a'), output('o')], edges: [edge] })
    const next = applyConnectionForReviewOutput(def, edge, { viaCatchAll: true })
    expect(next).toBe(def)
    expect(inboundPortNames(next, 'o')).toEqual(['audit_md'])
  })

  test('target is output, second catch-all drop with colliding name → edge re-targeted to `_2`', () => {
    // The hard requirement: output is multi-input. Two upstreams sharing
    // an output-port name (e.g. both call it `out`) must coexist on the
    // same output node — the second drop lands on a `_2`-suffixed port and
    // the pre-existing edge is untouched.
    const pre: WorkflowEdge = {
      id: 'pre',
      source: { nodeId: 'a', portName: 'out' },
      target: { nodeId: 'o', portName: 'out' },
    }
    const edge: WorkflowEdge = {
      id: 'new',
      source: { nodeId: 'b', portName: 'out' },
      target: { nodeId: 'o', portName: 'out' },
    }
    const def = makeDef({ nodes: [agent('a'), agent('b'), output('o')], edges: [pre, edge] })
    const next = applyConnectionForReviewOutput(def, edge, { viaCatchAll: true })
    expect(next.edges).toHaveLength(2)
    expect(next.edges.find((e) => e.id === 'new')!.target.portName).toBe('out_2')
    expect(next.edges.find((e) => e.id === 'pre')!.target.portName).toBe('out')
    expect(inboundPortNames(next, 'o')).toEqual(['out', 'out_2'])
  })

  test('target is output, catch-all drop with non-colliding name → port appended verbatim', () => {
    const existing: WorkflowEdge = {
      id: 'existing',
      source: { nodeId: 'a', portName: 'design' },
      target: { nodeId: 'o', portName: 'design' },
    }
    const edge: WorkflowEdge = {
      id: 'e1',
      source: { nodeId: 'b', portName: 'spec' },
      target: { nodeId: 'o', portName: 'spec' },
    }
    const def = makeDef({ nodes: [agent('a'), agent('b'), output('o')], edges: [existing, edge] })
    const next = applyConnectionForReviewOutput(def, edge, { viaCatchAll: true })
    expect(next).toBe(def)
    expect(inboundPortNames(next, 'o')).toEqual(['design', 'spec'])
  })

  test('target node does not exist → returns def unchanged', () => {
    const edge: WorkflowEdge = {
      id: 'e1',
      source: { nodeId: 'a', portName: 'design' },
      target: { nodeId: 'ghost', portName: REVIEW_INPUT_HANDLE_ID },
    }
    const def = makeDef({ nodes: [agent('a')], edges: [edge] })
    expect(applyConnectionForReviewOutput(def, edge)).toBe(def)
  })
})

// ---------------------------------------------------------------------------
// port-name helpers
// ---------------------------------------------------------------------------

describe('uniquePortName / inboundPortNames', () => {
  test('uniquePortName suffixes _2, _3, … only on collision', () => {
    expect(uniquePortName([], 'out')).toBe('out')
    expect(uniquePortName(['out'], 'out')).toBe('out_2')
    expect(uniquePortName(['out', 'out_2'], 'out')).toBe('out_3')
  })

  test('inboundPortNames lists distinct target ports and skips wrapper-output returns', () => {
    const def = makeDef({
      nodes: [agent('a'), output('o')],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'a', portName: 'x' },
          target: { nodeId: 'o', portName: 'p' },
        },
        {
          id: 'e2',
          source: { nodeId: 'a', portName: 'y' },
          target: { nodeId: 'o', portName: 'p' },
        },
        {
          id: 'ret',
          source: { nodeId: 'a', portName: 'z' },
          target: { nodeId: 'o', portName: 'q' },
          boundary: 'wrapper-output',
        },
      ],
    })
    expect(inboundPortNames(def, 'o')).toEqual(['p'])
  })
})

// ---------------------------------------------------------------------------
// source-level guard — RFC-354: no PortRef mirror can be written from here
// ---------------------------------------------------------------------------

describe('connectionSync.ts never writes a v5 PortRef field', () => {
  test('source contains no inputSource / ports / outputBindings write', () => {
    const src = readFileSync(
      resolve(__dirname, '..', 'src', 'components', 'canvas', 'connectionSync.ts'),
      'utf8',
    )
    expect(src).not.toMatch(/inputSource\s*:/)
    expect(src).not.toMatch(/\bports\s*:/)
    expect(src).not.toMatch(/outputBindings/)
    expect(src).not.toMatch(/healFieldEdgeConsistency|syncEdgeFromFormField/)
  })
})
