// LOCKS: RFC-055 — sharding strategy pure helpers.
// Mirrors design/RFC-055-fanout-sharding-strategy-inspector/design.md §7.1.
// Locks in:
//   - validateShardingStrategy: 6 case (3 ok shapes + 3 error codes)
//   - normalizeShardingStrategy: 4 case (kind flips preserve same-kind n/depth)
//   - applyShardingBackfill: 3 case (missing → backfill / valid → ref-eq / non-agent-multi untouched)

import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_SHARDING_STRATEGY,
  applyShardingBackfill,
  normalizeShardingStrategy,
  validateShardingStrategy,
} from '../src/sharding'
import { type WorkflowDefinition, type WorkflowNode } from '../src/schemas/workflow'

function def(nodes: WorkflowNode[]): WorkflowDefinition {
  return { $schema_version: 3, inputs: [], nodes, edges: [], outputs: [] }
}

describe('validateShardingStrategy', () => {
  test('per-file ok', () => {
    const r = validateShardingStrategy({ kind: 'per-file' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toEqual({ kind: 'per-file' })
  })

  test('per-n-files with n=5 ok', () => {
    const r = validateShardingStrategy({ kind: 'per-n-files', n: 5 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toEqual({ kind: 'per-n-files', n: 5 })
  })

  test('per-directory without depth ok (backend defaults to 1)', () => {
    const r = validateShardingStrategy({ kind: 'per-directory' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toEqual({ kind: 'per-directory' })
  })

  test('per-directory with depth=2 ok', () => {
    const r = validateShardingStrategy({ kind: 'per-directory', depth: 2 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toEqual({ kind: 'per-directory', depth: 2 })
  })

  test('unknown kind → kind-invalid', () => {
    expect(validateShardingStrategy({ kind: 'wrong' })).toEqual({
      ok: false,
      code: 'kind-invalid',
    })
    expect(validateShardingStrategy(null)).toEqual({ ok: false, code: 'kind-invalid' })
    expect(validateShardingStrategy('per-file')).toEqual({ ok: false, code: 'kind-invalid' })
  })

  test('per-n-files n missing / out-of-range', () => {
    expect(validateShardingStrategy({ kind: 'per-n-files' })).toEqual({
      ok: false,
      code: 'n-missing',
    })
    expect(validateShardingStrategy({ kind: 'per-n-files', n: 0 })).toEqual({
      ok: false,
      code: 'n-out-of-range',
    })
    expect(validateShardingStrategy({ kind: 'per-n-files', n: -3 })).toEqual({
      ok: false,
      code: 'n-out-of-range',
    })
    expect(validateShardingStrategy({ kind: 'per-n-files', n: 1.5 })).toEqual({
      ok: false,
      code: 'n-out-of-range',
    })
    // per-directory depth same family — locked here too so a future
    // regression on either code is caught at this one place.
    expect(validateShardingStrategy({ kind: 'per-directory', depth: 0 })).toEqual({
      ok: false,
      code: 'depth-out-of-range',
    })
  })
})

describe('normalizeShardingStrategy', () => {
  test('any prev + per-file → reset', () => {
    expect(normalizeShardingStrategy(undefined, 'per-file')).toEqual({ kind: 'per-file' })
    expect(normalizeShardingStrategy({ kind: 'per-n-files', n: 10 }, 'per-file')).toEqual({
      kind: 'per-file',
    })
  })

  test('same-kind per-n-files preserves n', () => {
    expect(normalizeShardingStrategy({ kind: 'per-n-files', n: 10 }, 'per-n-files')).toEqual({
      kind: 'per-n-files',
      n: 10,
    })
  })

  test('different-kind → per-n-files defaults to 5', () => {
    expect(normalizeShardingStrategy({ kind: 'per-file' }, 'per-n-files')).toEqual({
      kind: 'per-n-files',
      n: 5,
    })
    expect(normalizeShardingStrategy(undefined, 'per-n-files')).toEqual({
      kind: 'per-n-files',
      n: 5,
    })
  })

  test('same-kind per-directory preserves depth; missing depth stays missing', () => {
    expect(normalizeShardingStrategy({ kind: 'per-directory', depth: 3 }, 'per-directory')).toEqual(
      { kind: 'per-directory', depth: 3 },
    )
    expect(normalizeShardingStrategy({ kind: 'per-directory' }, 'per-directory')).toEqual({
      kind: 'per-directory',
    })
    expect(normalizeShardingStrategy({ kind: 'per-file' }, 'per-directory')).toEqual({
      kind: 'per-directory',
    })
  })
})

describe('applyShardingBackfill', () => {
  test('missing shardingStrategy on agent-multi → backfill per-file (new ref)', () => {
    const input = def([
      { id: 'a', kind: 'agent-multi' } as unknown as WorkflowNode,
      { id: 'b', kind: 'agent-single' } as unknown as WorkflowNode,
    ])
    const out = applyShardingBackfill(input)
    expect(out).not.toBe(input)
    expect((out.nodes[0] as unknown as Record<string, unknown>).shardingStrategy).toEqual({
      kind: 'per-file',
    })
    // non-agent-multi node identity preserved by the slice path
    expect(out.nodes[1]).toBe(input.nodes[1])
    // input was not mutated
    expect((input.nodes[0] as unknown as Record<string, unknown>).shardingStrategy).toBeUndefined()
    // default constant is `per-file`
    expect((out.nodes[0] as unknown as Record<string, unknown>).shardingStrategy).toEqual(
      DEFAULT_SHARDING_STRATEGY,
    )
  })

  test('valid shardingStrategy → idempotent (returns same ref)', () => {
    const input = def([
      {
        id: 'a',
        kind: 'agent-multi',
        shardingStrategy: { kind: 'per-n-files', n: 3 },
      } as unknown as WorkflowNode,
      {
        id: 'c',
        kind: 'agent-multi',
        shardingStrategy: { kind: 'per-directory', depth: 2 },
      } as unknown as WorkflowNode,
    ])
    const out1 = applyShardingBackfill(input)
    expect(out1).toBe(input)
    const out2 = applyShardingBackfill(out1)
    expect(out2).toBe(out1)
  })

  test('non-agent-multi nodes are never touched even when given invalid shape', () => {
    const input = def([
      { id: 'x', kind: 'agent-single', shardingStrategy: 'garbage' } as unknown as WorkflowNode,
      { id: 'y', kind: 'wrapper-git' } as unknown as WorkflowNode,
      {
        id: 'z',
        kind: 'agent-multi',
        shardingStrategy: { kind: 'wrong' },
      } as unknown as WorkflowNode,
    ])
    const out = applyShardingBackfill(input)
    // z (invalid) was backfilled
    expect((out.nodes[2] as unknown as Record<string, unknown>).shardingStrategy).toEqual({
      kind: 'per-file',
    })
    // x / y untouched
    expect((out.nodes[0] as unknown as Record<string, unknown>).shardingStrategy).toBe('garbage')
    expect(out.nodes[1]).toBe(input.nodes[1])
  })
})
