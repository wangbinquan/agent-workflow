// RFC-354 — locks `containerMemberRuns` / `frameChainOf`
// (modules/task-execution/domain/containerMembership.ts): membership of a
// wrapper execution is transitive through the container chain, at any depth.
//
// Why this test exists: before RFC-354 three call sites approximated "the rows
// of this wrapper execution" differently (inner node ids ∩ one iteration in
// wrapperRevivalEvidence — the depth-1 blind spot, audit S-3; parent pointer
// OR inner node ids in runLiveness.innerRunsOf). A nested loop's rows were
// invisible to all of them from the outer loop's second round on.

import { describe, expect, test } from 'bun:test'
import {
  containerMemberRuns,
  frameChainOf,
} from '../src/modules/task-execution/domain/containerMembership'

const rows = [
  { id: 'top_agent', containerRunId: null },
  { id: 'R_outer', containerRunId: null },
  { id: 'outer_body_r0', containerRunId: 'R_outer' },
  { id: 'R_inner_r0', containerRunId: 'R_outer' },
  { id: 'inner_body_r0_i0', containerRunId: 'R_inner_r0' },
  { id: 'inner_body_r0_i1', containerRunId: 'R_inner_r0' },
  { id: 'R_inner_r1', containerRunId: 'R_outer' },
  { id: 'inner_body_r1_i0', containerRunId: 'R_inner_r1' },
  { id: 'R_sibling', containerRunId: null },
  { id: 'sibling_body', containerRunId: 'R_sibling' },
]

describe('containerMemberRuns', () => {
  test('outer generation owns its body, nested generation rows and THEIR bodies', () => {
    expect(containerMemberRuns('R_outer', rows).map((r) => r.id)).toEqual([
      'outer_body_r0',
      'R_inner_r0',
      'inner_body_r0_i0',
      'inner_body_r0_i1',
      'R_inner_r1',
      'inner_body_r1_i0',
    ])
  })

  test('an inner generation owns only its own body — not its siblings of other rounds', () => {
    expect(containerMemberRuns('R_inner_r0', rows).map((r) => r.id)).toEqual([
      'inner_body_r0_i0',
      'inner_body_r0_i1',
    ])
    expect(containerMemberRuns('R_inner_r1', rows).map((r) => r.id)).toEqual(['inner_body_r1_i0'])
  })

  test('top-level rows and unrelated wrappers are never members; the row is not its own member', () => {
    const outer = containerMemberRuns('R_outer', rows).map((r) => r.id)
    expect(outer).not.toContain('R_outer')
    expect(outer).not.toContain('top_agent')
    expect(outer).not.toContain('R_sibling')
    expect(outer).not.toContain('sibling_body')
    expect(containerMemberRuns('unknown', rows)).toEqual([])
  })

  test('a dangling container pointer (row deleted) ends the chain instead of throwing', () => {
    const dangling = [{ id: 'x', containerRunId: 'gone' }]
    expect(containerMemberRuns('gone', dangling).map((r) => r.id)).toEqual(['x'])
    expect(containerMemberRuns('other', dangling)).toEqual([])
  })

  test('a container cycle terminates', () => {
    const cyclic = [
      { id: 'a', containerRunId: 'b' },
      { id: 'b', containerRunId: 'a' },
    ]
    expect(containerMemberRuns('a', cyclic).map((r) => r.id)).toEqual(['b'])
  })
})

describe('frameChainOf', () => {
  test('lists containers nearest-first up to the root', () => {
    const byId = (id: string) => rows.find((r) => r.id === id)
    expect(frameChainOf(rows[4]!, byId)).toEqual(['R_inner_r0', 'R_outer'])
    expect(frameChainOf(rows[0]!, byId)).toEqual([])
  })
})
