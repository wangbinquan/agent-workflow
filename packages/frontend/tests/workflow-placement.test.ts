// RFC-199 B4/T7.7 — pure collision-safe workflow placement.
//
// Placement always consumes and returns canonical absolute coordinates. Scope
// is explicit membership authority: geometry may block a candidate, but must
// never infer that a visually-contained node belongs to a wrapper.

import { describe, expect, test } from 'vitest'
import {
  centerAnchoredTopLeft,
  effectiveWorkflowNodePosition,
  findOpenPlacement,
  PLACEMENT_SEARCH_STEP,
  type WorkflowPlacementNode,
  type WorkflowPlacementRect,
} from '../src/lib/workflow-placement'

const noOverlap = (a: WorkflowPlacementRect, b: WorkflowPlacementRect, gap = 0): boolean =>
  a.x + a.width + gap <= b.x ||
  b.x + b.width + gap <= a.x ||
  a.y + a.height + gap <= b.y ||
  b.y + b.height + gap <= a.y

const node = (
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
  directWrapperNodeId?: string,
): WorkflowPlacementNode => ({
  id,
  position: { x, y },
  defaultSize: { width, height },
  directWrapperNodeId,
})

describe('findOpenPlacement', () => {
  test('legacy nodes without positions use the renderer tile grid in placement inventory', () => {
    const legacyNodes = [{}, {}]
    const positions = legacyNodes.map((legacy, index) =>
      effectiveWorkflowNodePosition(legacy, index),
    )
    expect(positions).toEqual([
      { x: 80, y: 80 },
      { x: 360, y: 80 },
    ])

    const occupied: WorkflowPlacementNode[] = positions.map((position, index) => ({
      id: `legacy-${index}`,
      position,
      defaultSize: { width: 280, height: 180 },
    }))
    expect(
      findOpenPlacement({
        desiredPoint: positions[1]!,
        candidateSize: { width: 280, height: 180 },
        scope: { kind: 'top-level' },
        nodes: occupied,
        wrapperRects: [],
        gap: 0,
      }),
    ).not.toEqual(positions[1])
  })

  test('returns an unoccupied desired canonical absolute point unchanged', () => {
    expect(
      findOpenPlacement({
        desiredPoint: { x: 412.5, y: 275.25 },
        candidateSize: { width: 100, height: 80 },
        scope: { kind: 'top-level' },
        nodes: [],
        wrapperRects: [],
      }),
    ).toEqual({ x: 412.5, y: 275.25 })
  })

  test('consecutive adds resolve to the nearest open shell deterministically and never overlap', () => {
    const desiredPoint = { x: 0, y: 0 }
    const candidateSize = { width: 100, height: 80 }
    const gap = 10
    const occupied: WorkflowPlacementNode[] = [node('existing', 0, 0, 100, 80)]

    // Vertical clearance (90) is nearer than horizontal (110), so the first
    // open 16px shell is ring 6 straight below the origin — not a full
    // node-stride jump to the right like the pre-fix stride spiral.
    const first = findOpenPlacement({
      desiredPoint,
      candidateSize,
      scope: { kind: 'top-level' },
      nodes: occupied,
      wrapperRects: [],
      gap,
    })
    expect(first).toEqual({ x: 0, y: 6 * PLACEMENT_SEARCH_STEP })
    occupied.push(node('first', first.x, first.y, 100, 80))

    // With below occupied too, the same distance opens upward next.
    const second = findOpenPlacement({
      desiredPoint,
      candidateSize,
      scope: { kind: 'top-level' },
      nodes: occupied,
      wrapperRects: [],
      gap,
    })
    expect(second).toEqual({ x: 0, y: -6 * PLACEMENT_SEARCH_STEP })

    const secondRect = { ...second, ...candidateSize }
    for (const existing of occupied) {
      expect(
        noOverlap(
          secondRect,
          {
            ...existing.position,
            ...(existing.measuredSize ?? existing.defaultSize),
          },
          gap,
        ),
      ).toBe(true)
    }
    expect(
      findOpenPlacement({
        desiredPoint,
        candidateSize,
        scope: { kind: 'top-level' },
        nodes: occupied,
        wrapperRects: [],
        gap,
      }),
    ).toEqual(second)
  })

  test('a near-miss drop nudges by one 16px step, not a full node stride', () => {
    // Desired sits 5px shy of horizontal clearance (needs x >= 110). The fix
    // must resolve this with a minimal nudge; the pre-fix stride spiral
    // teleported to x = 215 (desired + width + gap) instead.
    const placed = findOpenPlacement({
      desiredPoint: { x: 105, y: 0 },
      candidateSize: { width: 100, height: 80 },
      scope: { kind: 'top-level' },
      nodes: [node('existing', 0, 0, 100, 80)],
      wrapperRects: [],
      gap: 10,
    })
    expect(placed).toEqual({ x: 105 + PLACEMENT_SEARCH_STEP, y: 0 })
  })

  test('a drop over a top-level wrapper lands adjacent to the wrapper, not a stride away', () => {
    // Dropping onto a large wrapper rect must eject the node, but only just
    // past the nearest wrapper edge (up: 30 -> -82 clears 400px-tall rect plus
    // the 16px gap), never a whole extra node stride beyond it.
    const placed = findOpenPlacement({
      desiredPoint: { x: 300, y: 30 },
      candidateSize: { width: 80, height: 60 },
      scope: { kind: 'top-level' },
      nodes: [],
      wrapperRects: [{ id: 'big', x: 0, y: 0, width: 600, height: 400 }],
      gap: 16,
    })
    expect(placed).toEqual({ x: 300, y: 30 - 7 * PLACEMENT_SEARCH_STEP })
    expect(
      noOverlap({ ...placed, width: 80, height: 60 }, { x: 0, y: 0, width: 600, height: 400 }, 16),
    ).toBe(true)
  })

  test('an occupied center moves, and measured node size wins over its default rect', () => {
    const measuredNode: WorkflowPlacementNode = {
      ...node('wide', 0, 0, 40, 40),
      measuredSize: { width: 180, height: 80 },
    }
    const desiredPoint = { x: 50, y: 0 }
    const candidateSize = { width: 40, height: 40 }

    const withMeasured = findOpenPlacement({
      desiredPoint,
      candidateSize,
      scope: { kind: 'top-level' },
      nodes: [measuredNode],
      wrapperRects: [],
      gap: 0,
    })
    const withDefaultOnly = findOpenPlacement({
      desiredPoint,
      candidateSize,
      scope: { kind: 'top-level' },
      nodes: [{ ...measuredNode, measuredSize: undefined }],
      wrapperRects: [],
      gap: 0,
    })

    expect(withMeasured).not.toEqual(desiredPoint)
    expect(withDefaultOnly).toEqual(desiredPoint)
    expect(
      noOverlap({ ...withMeasured, ...candidateSize }, { x: 0, y: 0, width: 180, height: 80 }),
    ).toBe(true)
  })

  test('top-level placement treats a top-level wrapper visual rect as occupied', () => {
    const wrapper = {
      id: 'outer',
      x: 0,
      y: 0,
      width: 300,
      height: 200,
    }
    const candidateSize = { width: 80, height: 60 }
    const placed = findOpenPlacement({
      desiredPoint: { x: 100, y: 50 },
      candidateSize,
      scope: { kind: 'top-level' },
      nodes: [],
      wrapperRects: [wrapper],
      gap: 0,
    })

    expect(placed).not.toEqual({ x: 100, y: 50 })
    expect(noOverlap({ ...placed, ...candidateSize }, wrapper)).toBe(true)
  })

  test('wrapper scope avoids only explicit direct members and never infers membership from containment', () => {
    const desiredPoint = { x: 1120, y: 640 }
    const candidateSize = { width: 60, height: 40 }
    const visuallyContainingWrapper = {
      id: 'target',
      x: 1000,
      y: 500,
      width: 500,
      height: 400,
    }
    const visualOutsider = node('outsider', 1120, 640, 60, 40, 'other-wrapper')

    const ignoredOutsider = findOpenPlacement({
      desiredPoint,
      candidateSize,
      scope: { kind: 'wrapper', wrapperNodeId: 'target' },
      nodes: [visualOutsider],
      wrapperRects: [visuallyContainingWrapper],
      gap: 0,
    })
    // Still canonical absolute — no subtraction of the target wrapper origin.
    expect(ignoredOutsider).toEqual(desiredPoint)

    const directMember = node('direct', 1120, 640, 60, 40, 'target')
    const avoidedMember = findOpenPlacement({
      desiredPoint,
      candidateSize,
      scope: { kind: 'wrapper', wrapperNodeId: 'target' },
      nodes: [visualOutsider, directMember],
      wrapperRects: [visuallyContainingWrapper],
      gap: 0,
    })
    expect(avoidedMember).not.toEqual(desiredPoint)
  })

  test('wrapper scope fails closed when the target wrapper is missing', () => {
    expect(() =>
      findOpenPlacement({
        desiredPoint: { x: 0, y: 0 },
        candidateSize: { width: 80, height: 60 },
        scope: { kind: 'wrapper', wrapperNodeId: 'missing' },
        nodes: [],
        wrapperRects: [],
      }),
    ).toThrow(/target wrapper 'missing'.*missing/i)
  })

  test('empty wrapper clamps an outside desired point so the full candidate stays inside', () => {
    const wrapper = { id: 'target', x: 100, y: 200, width: 300, height: 220 }
    const candidateSize = { width: 80, height: 60 }
    const placed = findOpenPlacement({
      desiredPoint: { x: -500, y: 1_000 },
      candidateSize,
      scope: { kind: 'wrapper', wrapperNodeId: 'target' },
      nodes: [],
      wrapperRects: [wrapper],
      gap: 0,
    })

    expect(placed).toEqual({ x: 100, y: 360 })
    expect(placed.x).toBeGreaterThanOrEqual(wrapper.x)
    expect(placed.y).toBeGreaterThanOrEqual(wrapper.y)
    expect(placed.x + candidateSize.width).toBeLessThanOrEqual(wrapper.x + wrapper.width)
    expect(placed.y + candidateSize.height).toBeLessThanOrEqual(wrapper.y + wrapper.height)
  })

  test('wrapper scope fails explicitly when its content rect cannot fit the candidate', () => {
    expect(() =>
      findOpenPlacement({
        desiredPoint: { x: 10, y: 10 },
        candidateSize: { width: 120, height: 80 },
        scope: { kind: 'wrapper', wrapperNodeId: 'small' },
        nodes: [],
        wrapperRects: [{ id: 'small', x: 0, y: 0, width: 100, height: 60 }],
      }),
    ).toThrow(/wrapper 'small'.*cannot fit/i)
  })

  test('wrapper scope fails explicitly when direct members occupy all available space', () => {
    expect(() =>
      findOpenPlacement({
        desiredPoint: { x: 0, y: 0 },
        candidateSize: { width: 20, height: 20 },
        scope: { kind: 'wrapper', wrapperNodeId: 'full' },
        nodes: [node('occupant', 0, 0, 100, 100, 'full')],
        wrapperRects: [{ id: 'full', x: 0, y: 0, width: 100, height: 100 }],
        gap: 0,
        maxRings: 4,
      }),
    ).toThrow(/no open workflow placement.*wrapper 'full' content bounds/i)
  })

  test('a nested wrapper rect blocks placement only for its explicit direct parent scope', () => {
    const outer = { id: 'outer', x: 0, y: 0, width: 500, height: 400 }
    const other = { id: 'other', x: 0, y: 0, width: 500, height: 400 }
    const nested = {
      id: 'nested',
      x: 100,
      y: 100,
      width: 240,
      height: 160,
      directWrapperNodeId: 'outer',
    }
    const candidateSize = { width: 80, height: 60 }

    const inOuter = findOpenPlacement({
      desiredPoint: { x: 120, y: 120 },
      candidateSize,
      scope: { kind: 'wrapper', wrapperNodeId: 'outer' },
      nodes: [],
      wrapperRects: [outer, other, nested],
      gap: 0,
    })
    const inOther = findOpenPlacement({
      desiredPoint: { x: 120, y: 120 },
      candidateSize,
      scope: { kind: 'wrapper', wrapperNodeId: 'other' },
      nodes: [],
      wrapperRects: [outer, other, nested],
      gap: 0,
    })

    expect(inOuter).not.toEqual({ x: 120, y: 120 })
    expect(inOuter.x).toBeGreaterThanOrEqual(outer.x)
    expect(inOuter.y).toBeGreaterThanOrEqual(outer.y)
    expect(inOuter.x + candidateSize.width).toBeLessThanOrEqual(outer.x + outer.width)
    expect(inOuter.y + candidateSize.height).toBeLessThanOrEqual(outer.y + outer.height)
    expect(inOther).toEqual({ x: 120, y: 120 })
  })
})

describe('centerAnchoredTopLeft', () => {
  test('centers the candidate under the anchor point and rounds zoom fractions', () => {
    expect(centerAnchoredTopLeft({ x: 300.7, y: 100.2 }, { width: 280, height: 180 })).toEqual({
      x: 161,
      y: 10,
    })
    expect(centerAnchoredTopLeft({ x: 0, y: 0 }, { width: 220, height: 120 })).toEqual({
      x: -110,
      y: -60,
    })
  })
})
