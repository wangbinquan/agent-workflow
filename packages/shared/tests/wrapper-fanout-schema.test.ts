// RFC-060 PR-C — wrapper-fanout schema additions.
//
// Locks:
//  1. NODE_KIND enum includes 'wrapper-fanout'.
//  2. isProcessNodeKind('wrapper-fanout') === true.
//  3. WrapperFanoutNodeSchema parses minimal shape + inputs[] / nodeIds[].
//  4. WrapperFanoutPortSchema enforces non-empty name + non-empty kind.
//  5. WorkflowEdgeSchema accepts optional boundary 'wrapper-input' /
//     'wrapper-output'; missing boundary stays valid.
//  6. EdgeBoundarySchema rejects unknown values.
//  7. expectedShardCount is optional positive integer ≤ 10_000.

import { describe, expect, test } from 'bun:test'
import {
  EdgeBoundarySchema,
  NODE_KIND,
  WorkflowEdgeSchema,
  WrapperFanoutNodeSchema,
  WrapperFanoutPortSchema,
  isProcessNodeKind,
} from '../src/schemas/workflow'

describe('NODE_KIND enum', () => {
  test("includes 'wrapper-fanout'", () => {
    expect(NODE_KIND).toContain('wrapper-fanout')
  })

  test('still includes existing kinds (no removals)', () => {
    for (const kind of [
      'agent-single',
      'agent-multi',
      'input',
      'output',
      'wrapper-git',
      'wrapper-loop',
      'review',
      'clarify',
      'clarify-cross-agent',
    ]) {
      expect(NODE_KIND).toContain(kind)
    }
  })
})

describe('isProcessNodeKind', () => {
  test("'wrapper-fanout' is a process kind", () => {
    expect(isProcessNodeKind('wrapper-fanout')).toBe(true)
  })

  test('existing process kinds remain process kinds', () => {
    for (const kind of ['agent-single', 'agent-multi', 'wrapper-git', 'wrapper-loop'] as const) {
      expect(isProcessNodeKind(kind)).toBe(true)
    }
  })

  test('non-process kinds stay non-process', () => {
    for (const kind of ['input', 'output', 'review', 'clarify', 'clarify-cross-agent'] as const) {
      expect(isProcessNodeKind(kind)).toBe(false)
    }
  })
})

describe('WrapperFanoutPortSchema', () => {
  test('minimal port (name + kind) valid', () => {
    expect(WrapperFanoutPortSchema.parse({ name: 'docs', kind: 'list<path<md>>' })).toEqual({
      name: 'docs',
      kind: 'list<path<md>>',
    })
  })

  test('port with isShardSource flag valid', () => {
    const parsed = WrapperFanoutPortSchema.parse({
      name: 'docs',
      kind: 'list<path<md>>',
      isShardSource: true,
    })
    expect(parsed.isShardSource).toBe(true)
  })

  test('rejects empty name', () => {
    expect(() => WrapperFanoutPortSchema.parse({ name: '', kind: 'string' })).toThrow()
  })

  test('rejects empty kind', () => {
    expect(() => WrapperFanoutPortSchema.parse({ name: 'p', kind: '' })).toThrow()
  })
})

describe('WrapperFanoutNodeSchema', () => {
  test('minimal node valid', () => {
    const node = WrapperFanoutNodeSchema.parse({ id: 'w1', kind: 'wrapper-fanout' })
    expect(node.kind).toBe('wrapper-fanout')
    expect(node.nodeIds).toEqual([])
    expect(node.inputs).toEqual([])
  })

  test('with nodeIds + inputs', () => {
    const node = WrapperFanoutNodeSchema.parse({
      id: 'w1',
      kind: 'wrapper-fanout',
      nodeIds: ['agent_a', 'agent_b'],
      inputs: [
        { name: 'docs', kind: 'list<path<md>>', isShardSource: true },
        { name: 'spec', kind: 'path<md>' },
      ],
    })
    expect(node.nodeIds).toEqual(['agent_a', 'agent_b'])
    expect(node.inputs).toHaveLength(2)
    expect(node.inputs[0]!.isShardSource).toBe(true)
  })

  test('expectedShardCount optional integer 1..10_000', () => {
    expect(
      WrapperFanoutNodeSchema.parse({
        id: 'w1',
        kind: 'wrapper-fanout',
        expectedShardCount: 16,
      }).expectedShardCount,
    ).toBe(16)
    expect(() =>
      WrapperFanoutNodeSchema.parse({ id: 'w1', kind: 'wrapper-fanout', expectedShardCount: 0 }),
    ).toThrow()
    expect(() =>
      WrapperFanoutNodeSchema.parse({
        id: 'w1',
        kind: 'wrapper-fanout',
        expectedShardCount: 20_000,
      }),
    ).toThrow()
  })

  test('rejects wrong literal kind', () => {
    expect(() => WrapperFanoutNodeSchema.parse({ id: 'w1', kind: 'agent-single' })).toThrow()
  })
})

describe('WorkflowEdgeSchema — boundary', () => {
  test('edge without boundary still valid (back-compat)', () => {
    const edge = WorkflowEdgeSchema.parse({
      id: 'e1',
      source: { nodeId: 'a', portName: 'out' },
      target: { nodeId: 'b', portName: 'in' },
    })
    expect(edge.boundary).toBeUndefined()
  })

  test("boundary: 'wrapper-input' valid", () => {
    const edge = WorkflowEdgeSchema.parse({
      id: 'e1',
      source: { nodeId: 'wrap', portName: 'docs' },
      target: { nodeId: 'agent', portName: 'doc' },
      boundary: 'wrapper-input',
    })
    expect(edge.boundary).toBe('wrapper-input')
  })

  test("boundary: 'wrapper-output' valid", () => {
    const edge = WorkflowEdgeSchema.parse({
      id: 'e1',
      source: { nodeId: 'agg', portName: 'final' },
      target: { nodeId: 'wrap', portName: 'final' },
      boundary: 'wrapper-output',
    })
    expect(edge.boundary).toBe('wrapper-output')
  })

  test('boundary rejects unknown value', () => {
    expect(() =>
      WorkflowEdgeSchema.parse({
        id: 'e1',
        source: { nodeId: 'a', portName: 'x' },
        target: { nodeId: 'b', portName: 'y' },
        boundary: 'sideways',
      }),
    ).toThrow()
  })

  test('EdgeBoundarySchema accepts the two values only', () => {
    expect(EdgeBoundarySchema.parse('wrapper-input')).toBe('wrapper-input')
    expect(EdgeBoundarySchema.parse('wrapper-output')).toBe('wrapper-output')
    expect(() => EdgeBoundarySchema.parse('whatever')).toThrow()
  })
})
