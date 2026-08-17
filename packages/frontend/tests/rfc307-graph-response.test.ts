// RFC-307 — reading the stage-graph response.
//
// This file exists because of a real crash caught by the gate, not a
// hypothetical. Both callers originally wrote:
//
//     'reason' in data ? renderNoContract() : data.nodes.map(...)
//
// which is wrong in a way that is easy to miss: the negative of "the server
// said there is no stage contract" is not "the server sent a graph", it is "the
// server sent something else". Under a test harness whose API stub answers
// unknown paths with a bare object, `.nodes` was undefined and `.map` threw
// INSIDE RENDER — taking down the whole `/code` page, including the two tabs
// that have nothing to do with this feature.
//
// The check now lives in one function, and these cases pin the three answers it
// must keep distinct.

import { describe, expect, test } from 'vitest'
import { readGraph } from '../src/components/code/graphResponse'

describe('readGraph', () => {
  test('a graph is read as a graph', () => {
    const answer = readGraph({
      capability: 'mr-review',
      stageContractVer: 4,
      nodes: [{ name: 'collect' }],
      edges: [{ id: 'e', from: 'a', to: 'b', artifact: 'x' }],
    })
    expect(answer.kind).toBe('graph')
    if (answer.kind !== 'graph') return
    expect(answer.stageContractVer).toBe(4)
    expect(answer.nodes).toHaveLength(1)
    expect(answer.edges).toHaveLength(1)
  })

  test("'no contract' is its own answer, distinct from 'nothing arrived'", () => {
    // `mr-monitor` genuinely has no sequence; the UI says so in words. Folding
    // it into `none` would render a blank area that reads as a broken page.
    expect(readGraph({ capability: 'mr-monitor', reason: 'no-stage-contract' }).kind).toBe(
      'no-contract',
    )
  })

  test('a body in NEITHER shape is none — the crash this function exists to stop', () => {
    for (const body of [undefined, null, {}, { capability: 'mr-review' }, [], 'nope', 42]) {
      expect(readGraph(body).kind).toBe('none')
    }
  })

  test('nodes that is present but not an array is still none', () => {
    // The specific shape a partial or error body takes.
    expect(readGraph({ nodes: null }).kind).toBe('none')
    expect(readGraph({ nodes: { '0': 'collect' } }).kind).toBe('none')
  })

  test('a graph missing its version is still usable', () => {
    // Losing the staleness notice is a small cost; discarding an entire
    // sequence over one absent number is not a trade worth making.
    const answer = readGraph({ nodes: [], edges: [] })
    expect(answer.kind).toBe('graph')
    if (answer.kind !== 'graph') return
    expect(answer.stageContractVer).toBe(0)
  })

  test('a graph missing its edges draws as nodes with no edges, not as nothing', () => {
    const answer = readGraph({ nodes: [{ name: 'a' }], stageContractVer: 1 })
    expect(answer.kind).toBe('graph')
    if (answer.kind !== 'graph') return
    expect(answer.edges).toEqual([])
  })
})
