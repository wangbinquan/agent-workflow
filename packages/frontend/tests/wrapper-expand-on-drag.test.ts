// Locks the auto-fit rule for wrappers after an inner node is dragged:
// when the dragged inner node stays inside the wrapper, the wrapper's
// persisted position + size must SNAP so each side sits exactly the
// target clearance away from the inner-node bbox. Bidirectional — grows
// when crowded, shrinks when overgrown.
//
// Why the test exists: without auto-fit on drag-stop, a user who drags
// an inner agent toward the wrapper border ends up with handle dots /
// port labels overlapping the wrapper edge, AND dragging a node back
// toward the wrapper centre leaves stale empty space the user has to
// trim manually via "Fit to children". The bidirectional snap keeps the
// wrapper rect visually identical to a freshly-fit one (so a wrapper
// edited by either path looks the same).
//
// Companion to wrapper-fit-bounds.test.ts (from-scratch fit). The two
// helpers must agree on clearance constants — if either drifts, this
// file's "shrink matches computeFitBounds" test will flip red.

import { describe, expect, test } from 'vitest'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import {
  DEFAULT_NODE_SIZE_BY_KIND,
  WRAPPER_DEFAULT_PADDING,
  WRAPPER_HEADER_HEIGHT,
  computeFitBounds,
  fitWrapperToInner,
} from '../src/components/canvas/wrapperFit'

const HANDLE_SLACK = 16
const LEFT_CLEAR = WRAPPER_DEFAULT_PADDING + HANDLE_SLACK
const RIGHT_CLEAR = WRAPPER_DEFAULT_PADDING + HANDLE_SLACK
const TOP_CLEAR = WRAPPER_DEFAULT_PADDING + WRAPPER_HEADER_HEIGHT
const BOTTOM_CLEAR = WRAPPER_DEFAULT_PADDING

const AGENT_SZ = DEFAULT_NODE_SIZE_BY_KIND['agent-single']

function wrapper(
  id: string,
  nodeIds: string[],
  pos: { x: number; y: number },
  size: { width: number; height: number; sizeLocked?: boolean } | undefined,
): WorkflowNode {
  return {
    id,
    kind: 'wrapper-git',
    position: pos,
    nodeIds,
    ...(size !== undefined ? { size } : {}),
  } as unknown as WorkflowNode
}
function agent(id: string, pos: { x: number; y: number }): WorkflowNode {
  return { id, kind: 'agent-single', position: pos, agentName: 'a' } as unknown as WorkflowNode
}
function def(nodes: WorkflowNode[]): WorkflowDefinition {
  return { schemaVersion: 1, version: 1, nodes, edges: [] } as unknown as WorkflowDefinition
}

type SizedWrapper = WorkflowNode & {
  position: { x: number; y: number }
  size: { width: number; height: number }
}
function sizedWrapperById(d: WorkflowDefinition, id: string): SizedWrapper {
  const n = d.nodes.find((x) => x.id === id)
  if (n === undefined) throw new Error(`wrapper ${id} not in nodes`)
  return n as SizedWrapper
}

describe('fitWrapperToInner', () => {
  test('returns prevDef by reference when the wrapper id is missing', () => {
    const d = def([agent('a', { x: 0, y: 0 })])
    expect(fitWrapperToInner(d, 'nope')).toBe(d)
  })

  test('returns prevDef by reference for a non-wrapper target', () => {
    const d = def([agent('a', { x: 0, y: 0 })])
    expect(fitWrapperToInner(d, 'a')).toBe(d)
  })

  test('no-op when wrapper has no persisted size yet (first-render path)', () => {
    // Without persisted size, computeFitBounds already produces an exact-
    // clearance rect on render — there is nothing to re-fit against, so
    // this helper must short-circuit by reference.
    const d = def([wrapper('w', ['a'], { x: 0, y: 0 }, undefined), agent('a', { x: 50, y: 50 })])
    expect(fitWrapperToInner(d, 'w')).toBe(d)
  })

  test('no-op when sizeLocked=true (user pinned the wrapper)', () => {
    // The user has explicitly locked this wrapper's size; auto-fit must
    // not stomp on that decision even when inner-node positions would
    // imply a different rect.
    const d = def([
      wrapper('w', ['a'], { x: 0, y: 0 }, { width: 300, height: 200, sizeLocked: true }),
      // Inner sits at the wrapper's exact top-left → would crowd the
      // border, but sizeLocked overrides.
      agent('a', { x: 0, y: 0 }),
    ])
    expect(fitWrapperToInner(d, 'w')).toBe(d)
  })

  test('no-op when the wrapper rect already matches the target clearance', () => {
    // Inner node placed so all four clearances are already exact.
    const innerX = 200
    const innerY = 200
    const wrapW = AGENT_SZ.width + LEFT_CLEAR + RIGHT_CLEAR
    const wrapH = AGENT_SZ.height + TOP_CLEAR + BOTTOM_CLEAR
    const d = def([
      wrapper(
        'w',
        ['a'],
        { x: innerX - LEFT_CLEAR, y: innerY - TOP_CLEAR },
        {
          width: wrapW,
          height: wrapH,
        },
      ),
      agent('a', { x: innerX, y: innerY }),
    ])
    expect(fitWrapperToInner(d, 'w')).toBe(d)
  })

  test('GROWS left + top when the dragged inner node crowds the top-left corner', () => {
    // Wrapper starts large enough on the right + bottom; we then "drag"
    // the inner node 50px closer to the top-left than the clearance
    // allows. Auto-fit must shift wrapper top-left up/left AND snap the
    // right + bottom edges to their target clearance (bidirectional).
    const innerX = 110
    const innerY = 110
    const d = def([
      // Wrapper deliberately oversized on the right + bottom so the
      // shrink-side behavior shows up alongside the grow-side.
      wrapper('w', ['a'], { x: 100, y: 100 }, { width: 800, height: 600 }),
      agent('a', { x: innerX, y: innerY }),
    ])
    const next = fitWrapperToInner(d, 'w')
    expect(next).not.toBe(d)
    const w = sizedWrapperById(next, 'w')
    // Top-left grew outward (inner was crowding).
    expect(w.position).toEqual({ x: innerX - LEFT_CLEAR, y: innerY - TOP_CLEAR })
    // Right + bottom snapped INWARD to exact clearance (shrink leg).
    expect(w.position.x + w.size.width).toBe(innerX + AGENT_SZ.width + RIGHT_CLEAR)
    expect(w.position.y + w.size.height).toBe(innerY + AGENT_SZ.height + BOTTOM_CLEAR)
    // Inner node's absolute position is preserved — only the wrapper moved.
    const a = next.nodes.find((n) => n.id === 'a') as WorkflowNode
    expect(a.position).toEqual({ x: innerX, y: innerY })
  })

  test('GROWS right + bottom when the dragged inner node crowds the bottom-right corner', () => {
    // Inner agent crowds bottom-right; wrapper grows there. The top-left
    // side starts at clearance, so it stays put.
    const wrapX = 0
    const wrapY = 0
    const innerX = wrapX + LEFT_CLEAR // exact clearance on the left
    const innerY = wrapY + TOP_CLEAR // exact clearance on the top
    // Wrapper too tight on the right + bottom for the inner footprint.
    const wrapW = LEFT_CLEAR + AGENT_SZ.width + 5
    const wrapH = TOP_CLEAR + AGENT_SZ.height + 5
    const d = def([
      wrapper('w', ['a'], { x: wrapX, y: wrapY }, { width: wrapW, height: wrapH }),
      agent('a', { x: innerX, y: innerY }),
    ])
    const next = fitWrapperToInner(d, 'w')
    expect(next).not.toBe(d)
    const w = sizedWrapperById(next, 'w')
    // Top-left held (already at clearance).
    expect(w.position).toEqual({ x: wrapX, y: wrapY })
    // Right + bottom grew to clear the inner footprint.
    expect(w.position.x + w.size.width).toBe(innerX + AGENT_SZ.width + RIGHT_CLEAR)
    expect(w.position.y + w.size.height).toBe(innerY + AGENT_SZ.height + BOTTOM_CLEAR)
  })

  // 2026-05-24 — bidirectional fit (added on follow-up request: "if the
  // nearest inner node is too far from any edge, the wrapper should also
  // shrink back"). Locks the shrink leg so a future refactor that
  // accidentally re-introduces "expand-only" semantics flips red.
  test('SHRINKS all four sides when the inner node sits well inside an over-sized wrapper', () => {
    // The user has dragged the only inner node toward the wrapper centre
    // (e.g. after first crowding a corner, they pulled back). The wrapper
    // is now much larger than needed on every side; auto-fit must snap
    // every side inward to exact clearance.
    const innerX = 500
    const innerY = 400
    const d = def([
      wrapper('w', ['a'], { x: 0, y: 0 }, { width: 1200, height: 900 }),
      agent('a', { x: innerX, y: innerY }),
    ])
    const next = fitWrapperToInner(d, 'w')
    expect(next).not.toBe(d)
    const w = sizedWrapperById(next, 'w')
    // Every side snapped to the inner ± clearance.
    expect(w.position).toEqual({ x: innerX - LEFT_CLEAR, y: innerY - TOP_CLEAR })
    expect(w.position.x + w.size.width).toBe(innerX + AGENT_SZ.width + RIGHT_CLEAR)
    expect(w.position.y + w.size.height).toBe(innerY + AGENT_SZ.height + BOTTOM_CLEAR)
  })

  // 2026-05-24 — guards against the two helpers drifting apart. The
  // shrink leg of fitWrapperToInner exists precisely so that "drag stop
  // re-fit" and "Fit to children" produce visually identical wrappers;
  // if either side's clearance constants drift, this test catches it.
  test('shrunk rect matches computeFitBounds for the same inner-node layout', () => {
    const innerX = 500
    const innerY = 400
    const w0 = wrapper('w', ['a'], { x: 0, y: 0 }, { width: 1200, height: 900 })
    const a0 = agent('a', { x: innerX, y: innerY })
    const next = fitWrapperToInner(def([w0, a0]), 'w')
    const w = sizedWrapperById(next, 'w')
    const fit = computeFitBounds(w0, [w0, a0])
    expect(w.position).toEqual(fit.offset)
    expect(w.size.width).toBe(fit.width)
    expect(w.size.height).toBe(fit.height)
  })

  // RFC-199 T7.7: drag-stop fit must use the same recursively resolved visual
  // rect as first-render fit when a direct child is an unsized nested wrapper.
  test('nested wrapper without persisted size contributes its fitted rect on drag-stop', () => {
    const a = agent('a', { x: 100, y: 120 })
    const b = agent('b', { x: 700, y: 480 })
    const inner = wrapper('inner', ['a', 'b'], { x: 999, y: 999 }, undefined)
    const outer = wrapper('outer', ['inner'], { x: 0, y: 0 }, { width: 2000, height: 1500 })
    const nodes = [outer, inner, a, b]

    const next = fitWrapperToInner(def(nodes), 'outer')
    const fittedOuter = sizedWrapperById(next, 'outer')
    const expected = computeFitBounds(outer, nodes)

    expect(fittedOuter.position).toEqual(expected.offset)
    expect(fittedOuter.size.width).toBe(expected.width)
    expect(fittedOuter.size.height).toBe(expected.height)
  })

  test('uses measured size when provided (handles ports growing the inner footprint)', () => {
    // The static DEFAULT for agent-single is 280x180; here we feed a
    // larger measured size (400x300) to simulate a port-heavy agent. The
    // wrapper is deliberately too small in every direction for the
    // measured footprint, so all four edges must grow to that footprint
    // (not the default).
    const measured = new Map([['a', { width: 400, height: 300 }]])
    const d = def([
      wrapper('w', ['a'], { x: 0, y: 0 }, { width: 200, height: 150 }),
      agent('a', { x: 50, y: 50 }),
    ])
    const next = fitWrapperToInner(d, 'w', measured)
    expect(next).not.toBe(d)
    const w = sizedWrapperById(next, 'w')
    expect(w.position.x).toBe(50 - LEFT_CLEAR)
    expect(w.position.y).toBe(50 - TOP_CLEAR)
    expect(w.position.x + w.size.width).toBe(50 + 400 + RIGHT_CLEAR)
    expect(w.position.y + w.size.height).toBe(50 + 300 + BOTTOM_CLEAR)
  })

  test('preserves sizeLocked flag in the rewritten size record', () => {
    // sizeLocked=true short-circuits the helper (already covered above),
    // but defensively: if a caller ever passes a size record that lacks
    // sizeLocked, the rewritten size must NOT silently set it. We assert
    // the negative — the new size has no sizeLocked key.
    const d = def([
      wrapper('w', ['a'], { x: 100, y: 100 }, { width: 400, height: 300 }),
      agent('a', { x: 110, y: 110 }),
    ])
    const next = fitWrapperToInner(d, 'w')
    const w = sizedWrapperById(next, 'w')
    expect('sizeLocked' in (w.size as Record<string, unknown>)).toBe(false)
  })
})
