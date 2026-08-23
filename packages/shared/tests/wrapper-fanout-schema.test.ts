// RFC-060 PR-C — wrapper-fanout schema additions.
//
// Locks:
//  1. NODE_KIND enum includes 'wrapper-fanout'.
//  2. nodeKindParticipatesInRetryCascade('wrapper-fanout') === true.
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
} from '../src/schemas/workflow'
// RFC-146: the predicate moved to the behavior table (barrel export
// unchanged; this deep import follows the new home).
import { nodeKindParticipatesInRetryCascade } from '../src/node-kind-behavior'

describe('NODE_KIND enum', () => {
  test("includes 'wrapper-fanout'", () => {
    expect(NODE_KIND).toContain('wrapper-fanout')
  })

  test('still includes the long-standing kinds (agent-single + IO + wrappers + review/clarify)', () => {
    for (const kind of [
      'agent-single',
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
    // RFC-060 PR-E intentionally removed the legacy 'agent-multi' fan-out kind
    // (superseded by 'wrapper-fanout'; see the NODE_KIND comment in
    // schemas/workflow.ts). Lock that it stays gone so a future change can't
    // silently reintroduce it — and so this guard stops asserting a kind that
    // no longer exists (the stale `agent-multi` entry made this test red).
    expect(NODE_KIND).not.toContain('agent-multi')
  })
})

// RFC-317 T43 —— 原 `isProcessNodeKind` 已删（零生产调用者，测试拿它去断言它自己
// 读的那一列，纯同义反复）。「这个 kind 带不带进程」现在只有一条判据：
// `nodeKindParticipatesInRetryCascade`，它读 `retryCascade`——而 `retryCascade`
// 有真实生产消费者（services/task.ts retryNode）。下面按同样的意图改锚到活判据上。
describe('nodeKindParticipatesInRetryCascade', () => {
  test("'wrapper-fanout' is a process kind", () => {
    expect(nodeKindParticipatesInRetryCascade('wrapper-fanout')).toBe(true)
  })

  test('existing process kinds remain process kinds', () => {
    // 'agent-multi' dropped: RFC-060 PR-E removed it from NodeKind, so it's no
    // longer a (typed) process kind to assert here.
    for (const kind of ['agent-single', 'wrapper-git', 'wrapper-loop'] as const) {
      expect(nodeKindParticipatesInRetryCascade(kind)).toBe(true)
    }
  })

  test('non-process kinds stay non-process', () => {
    for (const kind of ['input', 'output', 'review', 'clarify', 'clarify-cross-agent'] as const) {
      expect(nodeKindParticipatesInRetryCascade(kind)).toBe(false)
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
