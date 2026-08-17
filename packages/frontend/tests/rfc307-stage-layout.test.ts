// RFC-307 — laying a stage sequence out so it can be read.
//
// The layout rules are here rather than inside the renderer because they are
// rules, and rules that live in a component get verified by squinting at a
// screenshot. Each case below pins a decision that has a wrong answer:
//
//   · run order must be readable as run order (x = position in the sequence);
//   · wrapping must not send a connector back across the whole canvas;
//   · a dependency that skips stages is a real feature of the contract and must
//     look different from a neighbour-to-neighbour one;
//   · an edge must not leave a card on the side it would then double back over.

import { describe, expect, test } from 'vitest'
import {
  STAGE_PER_ROW,
  STAGE_X_PITCH,
  STAGE_Y_PITCH,
  edgeHandles,
  layoutStageGraph,
  type StageLayoutKind,
} from '../src/components/code/stageLayout'

const seq = (count: number, kind: StageLayoutKind = 'program') =>
  Array.from({ length: count }, (_, index) => ({ name: `s${String(index)}`, kind, index }))

describe('RFC-307 stage layout', () => {
  test('run order reads left to right on the first row', () => {
    const { nodes } = layoutStageGraph({ nodes: seq(STAGE_PER_ROW), edges: [] })
    const xs = nodes.map((n) => n.x)
    expect(xs).toEqual([...xs].sort((a, b) => a - b))
    expect(nodes.every((n) => n.y === 0)).toBe(true)
  })

  test('wrapping runs alternate rows RIGHT TO LEFT, so the wrap is a short hop', () => {
    // Boustrophedon. Wrapping left-to-right on every row would send a connector
    // back across the entire canvas at each wrap, which is the single biggest
    // source of unreadable generated graphs.
    const { nodes } = layoutStageGraph({ nodes: seq(STAGE_PER_ROW * 2), edges: [] })
    const lastOfFirstRow = nodes[STAGE_PER_ROW - 1]
    const firstOfSecondRow = nodes[STAGE_PER_ROW]
    expect(firstOfSecondRow?.y).toBe(STAGE_Y_PITCH)
    // Directly below it — the wrap is vertical, not a long horizontal return.
    expect(firstOfSecondRow?.x).toBe(lastOfFirstRow?.x)
  })

  test('the second row runs backwards', () => {
    const { nodes } = layoutStageGraph({ nodes: seq(STAGE_PER_ROW * 2), edges: [] })
    const second = nodes.slice(STAGE_PER_ROW).map((n) => n.x)
    expect(second).toEqual([...second].sort((a, b) => b - a))
  })

  test('a thirteen-stage sequence wraps into three rows rather than one long line', () => {
    const { nodes, height } = layoutStageGraph({ nodes: seq(13), edges: [] })
    expect(new Set(nodes.map((n) => n.y)).size).toBe(3)
    expect(height).toBe(2 * STAGE_Y_PITCH + 120)
  })

  test('an edge that skips a stage is marked carried; a neighbour edge is not', () => {
    const { edges } = layoutStageGraph({
      nodes: seq(4),
      edges: [
        { id: 'near', from: 's0', to: 's1', artifact: 'a' },
        { id: 'far', from: 's0', to: 's3', artifact: 'b' },
      ],
    })
    expect(edges.find((e) => e.id === 'near')?.carried).toBe(false)
    expect(edges.find((e) => e.id === 'far')?.carried).toBe(true)
  })

  test('an edge with an unknown endpoint is drawn plainly, not dropped or thrown', () => {
    // A layout that refuses to draw because one lookup failed is worse than one
    // that draws a plain line.
    const { edges } = layoutStageGraph({
      nodes: seq(2),
      edges: [{ id: 'ghost', from: 's0', to: 'nowhere', artifact: 'a' }],
    })
    expect(edges).toHaveLength(1)
    expect(edges[0]?.carried).toBe(false)
  })

  test('width covers the widest row, not the whole sequence laid end to end', () => {
    const wide = layoutStageGraph({ nodes: seq(13), edges: [] })
    const narrow = layoutStageGraph({ nodes: seq(3), edges: [] })
    expect(wide.width).toBe((STAGE_PER_ROW - 1) * STAGE_X_PITCH + 200)
    expect(narrow.width).toBe(2 * STAGE_X_PITCH + 200)
  })

  test('an empty sequence still has positive dimensions', () => {
    // A zero-size canvas renders as nothing at all, which reads as a broken
    // page rather than as an empty one.
    const { width, height, nodes } = layoutStageGraph({ nodes: [], edges: [] })
    expect(nodes).toEqual([])
    expect(width).toBeGreaterThan(0)
    expect(height).toBeGreaterThan(0)
  })
})

describe('RFC-307 edge handles', () => {
  const at = (x: number, y: number) => ({ name: 'n', kind: 'program' as const, index: 0, x, y })

  test('a left-to-right neighbour leaves the right side and lands on the left', () => {
    expect(edgeHandles(at(0, 0), at(STAGE_X_PITCH, 0))).toEqual({
      source: 'right',
      target: 'left',
    })
  })

  test('on a right-to-left row the edge leaves the LEFT side', () => {
    // Leaving the right side here would double the connector back over the card
    // it just left — the specific ugliness boustrophedon exists to avoid.
    expect(edgeHandles(at(STAGE_X_PITCH, 0), at(0, 0))).toEqual({
      source: 'left',
      target: 'right',
    })
  })

  test('a wrap goes out the bottom and in the top', () => {
    expect(edgeHandles(at(0, 0), at(0, STAGE_Y_PITCH))).toEqual({
      source: 'bottom',
      target: 'top',
    })
  })

  test('a downward edge takes the vertical route even when it also moves sideways', () => {
    // Decided from coordinates rather than row parity, so carried edges that
    // span rows stay correct too.
    expect(edgeHandles(at(0, 0), at(3 * STAGE_X_PITCH, STAGE_Y_PITCH))).toEqual({
      source: 'bottom',
      target: 'top',
    })
  })
})
