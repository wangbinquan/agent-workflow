// RFC-016 §2.1 #1 + design §3.4: computeFitBounds is the auto-fit primitive
// for wrapper group containers. Locks padding=24 / header=22 / empty-fallback
// 200x120 and the "inner-node bbox + padding" growth rule. Red here usually
// means the canvas group rect would stop matching its inner content.

import { describe, expect, test } from 'vitest'
import type { WorkflowNode } from '@agent-workflow/shared'
import {
  computeFitBounds,
  DEFAULT_NODE_SIZE_BY_KIND,
  WRAPPER_DEFAULT_PADDING,
  WRAPPER_EMPTY_MIN_HEIGHT,
  WRAPPER_EMPTY_MIN_WIDTH,
  WRAPPER_HEADER_HEIGHT,
} from '../src/components/canvas/wrapperFit'

function wrapper(id: string, nodeIds: string[], pos = { x: 0, y: 0 }): WorkflowNode {
  return { id, kind: 'wrapper-git', position: pos, nodeIds } as unknown as WorkflowNode
}
function agentSingle(id: string, pos: { x: number; y: number }): WorkflowNode {
  return { id, kind: 'agent-single', position: pos, agentName: 'a' } as unknown as WorkflowNode
}

describe('computeFitBounds', () => {
  test('empty nodeIds returns the empty fallback rect at the wrapper position', () => {
    const w = wrapper('w1', [], { x: 100, y: 200 })
    const b = computeFitBounds(w, [w])
    expect(b.width).toBe(WRAPPER_EMPTY_MIN_WIDTH)
    expect(b.height).toBe(WRAPPER_EMPTY_MIN_HEIGHT)
    expect(b.offset).toEqual({ x: 100, y: 200 })
  })

  // RFC-016 follow-up: bounds now include HANDLE_SLACK=16 on each side of the
  // width axis so handle dots (RFC-006 pins them at -14px) don't graze the
  // wrapper edge. Height adds the header strip but no per-side slack.
  const HANDLE_SLACK = 16

  test('single inner node expands to inner-bbox + 2*padding (width) and +header (height)', () => {
    const a = agentSingle('a1', { x: 50, y: 80 })
    const w = wrapper('w1', ['a1'])
    const nodes = [w, a]
    const b = computeFitBounds(w, nodes)
    const sz = DEFAULT_NODE_SIZE_BY_KIND['agent-single']
    expect(b.width).toBe(sz.width + WRAPPER_DEFAULT_PADDING * 2 + HANDLE_SLACK * 2)
    expect(b.height).toBe(sz.height + WRAPPER_DEFAULT_PADDING * 2 + WRAPPER_HEADER_HEIGHT)
    expect(b.offset).toEqual({
      x: 50 - WRAPPER_DEFAULT_PADDING - HANDLE_SLACK,
      y: 80 - WRAPPER_DEFAULT_PADDING - WRAPPER_HEADER_HEIGHT,
    })
  })

  test('multiple inner nodes fit the union bbox', () => {
    const a = agentSingle('a1', { x: 0, y: 0 })
    const b = agentSingle('b1', { x: 300, y: 200 })
    const w = wrapper('w1', ['a1', 'b1'])
    const out = computeFitBounds(w, [w, a, b])
    const sz = DEFAULT_NODE_SIZE_BY_KIND['agent-single']
    expect(out.width).toBe(300 + sz.width + WRAPPER_DEFAULT_PADDING * 2 + HANDLE_SLACK * 2)
    expect(out.height).toBe(200 + sz.height + WRAPPER_DEFAULT_PADDING * 2 + WRAPPER_HEADER_HEIGHT)
  })

  test('multiple legacy inner nodes without positions use distinct canonical renderer tiles', () => {
    const w = wrapper('w1', ['a1', 'a2'])
    const a = { id: 'a1', kind: 'agent-single' } as unknown as WorkflowNode
    const b = { id: 'a2', kind: 'agent-single' } as unknown as WorkflowNode
    const out = computeFitBounds(w, [w, a, b])
    const sz = DEFAULT_NODE_SIZE_BY_KIND['agent-single']

    // Definition indices 1 and 2 render at x=360 and x=640 respectively.
    expect(out.width).toBe(280 + sz.width + WRAPPER_DEFAULT_PADDING * 2 + HANDLE_SLACK * 2)
  })

  test('inner wrapper contributes its persisted size to the bbox', () => {
    const innerWrap = {
      id: 'inner',
      kind: 'wrapper-loop',
      position: { x: 100, y: 100 },
      nodeIds: [],
      size: { width: 500, height: 300 },
    } as unknown as WorkflowNode
    const outer = wrapper('outer', ['inner'])
    const out = computeFitBounds(outer, [outer, innerWrap])
    expect(out.width).toBe(500 + WRAPPER_DEFAULT_PADDING * 2 + HANDLE_SLACK * 2)
    expect(out.height).toBe(300 + WRAPPER_DEFAULT_PADDING * 2 + WRAPPER_HEADER_HEIGHT)
  })

  // RFC-199 T7.7: an unsized nested wrapper renders at its own computed fit
  // rect. The outer wrapper must consume that resolved rect, rather than the
  // nested wrapper's stale position plus the small 240x160 kind fallback.
  test('inner wrapper without persisted size contributes its recursively fitted rect', () => {
    const a = agentSingle('a1', { x: 100, y: 120 })
    const b = agentSingle('a2', { x: 700, y: 480 })
    const inner = wrapper('inner', ['a1', 'a2'], { x: 999, y: 999 })
    const outer = wrapper('outer', ['inner'])
    const nodes = [outer, inner, a, b]

    const innerFit = computeFitBounds(inner, nodes)
    const outerFit = computeFitBounds(outer, nodes)

    expect(outerFit.offset).toEqual({
      x: innerFit.offset.x - WRAPPER_DEFAULT_PADDING - HANDLE_SLACK,
      y: innerFit.offset.y - WRAPPER_DEFAULT_PADDING - WRAPPER_HEADER_HEIGHT,
    })
    expect(outerFit.width).toBe(innerFit.width + WRAPPER_DEFAULT_PADDING * 2 + HANDLE_SLACK * 2)
    expect(outerFit.height).toBe(
      innerFit.height + WRAPPER_DEFAULT_PADDING * 2 + WRAPPER_HEADER_HEIGHT,
    )
  })

  test('measured sizes override DEFAULT_NODE_SIZE_BY_KIND when provided', () => {
    // Real-world reason: an agent with many port rows renders much taller
    // than the conservative DEFAULT estimate. Passing xyflow's measured
    // dimensions lets the wrapper fit to actual content.
    const a = agentSingle('a1', { x: 0, y: 0 })
    const w = wrapper('w1', ['a1'])
    const measured = new Map([['a1', { width: 600, height: 400 }]])
    const b = computeFitBounds(w, [w, a], WRAPPER_DEFAULT_PADDING, measured)
    expect(b.width).toBe(600 + WRAPPER_DEFAULT_PADDING * 2 + HANDLE_SLACK * 2)
    expect(b.height).toBe(400 + WRAPPER_DEFAULT_PADDING * 2 + WRAPPER_HEADER_HEIGHT)
  })

  test('never returns dimensions smaller than the empty fallback', () => {
    // single tiny node positioned at origin: width/height should still be at least the fallback min
    const tiny = { id: 't', kind: 'input', position: { x: 0, y: 0 } } as unknown as WorkflowNode
    const w = wrapper('w1', ['t'])
    const b = computeFitBounds(w, [w, tiny])
    expect(b.width).toBeGreaterThanOrEqual(WRAPPER_EMPTY_MIN_WIDTH)
    expect(b.height).toBeGreaterThanOrEqual(WRAPPER_EMPTY_MIN_HEIGHT)
  })
})
