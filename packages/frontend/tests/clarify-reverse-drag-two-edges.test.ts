// RFC-023 PR-C C6 — locks the two-edge invariant of the reverse-drag flow.
//
// Guard 1: buildClarifyEdges returns exactly two edges per call (literal-
// count assertion against the helper itself).
//
// Guard 2: scheduler.ts ignores the visual `clarify.answers → agent.__clarify_response__`
// edge when computing dataflow upstreams + topology — so deleting that
// edge in the canvas (the "second" edge in the pair) DOES NOT break answer
// injection. The runtime path goes through clarify_sessions rows +
// buildClarifyPromptContext, not through this edge. If the scheduler ever
// regresses to honoring the edge as a real dataflow dep, this grep guard
// fires.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildClarifyEdges } from '../src/components/canvas/clarifyDragHelper'

const SCHEDULER_PATH = join(__dirname, '..', '..', 'backend', 'src', 'services', 'scheduler.ts')

describe('clarify reverse-drag two-edge invariant (RFC-023 C6)', () => {
  it('buildClarifyEdges always returns two edges (ask + ans)', () => {
    const edges = buildClarifyEdges('a', 'c')
    expect(edges.length).toBe(2)
  })

  it('scheduler.ts skips clarify channel edges when building dep graph (answer-edge deletion safe)', () => {
    const src = readFileSync(SCHEDULER_PATH, 'utf8')
    // Both helpers must call out the system port names; if a refactor drops
    // the guard, the answers→agent edge becomes a hard upstream dep and
    // the cycle resolution breaks. Hard-code the literal port name match
    // so a rename can't slip through.
    expect(src).toContain('__clarify__')
    expect(src).toContain('__clarify_response__')
    // The two places to guard are buildScopeUpstreams + topologicalOrder.
    // Both must explicitly continue/skip on those port names.
    const buildScopePos = src.indexOf('function buildScopeUpstreams')
    expect(buildScopePos).toBeGreaterThan(-1)
    const toposortPos = src.indexOf('function topologicalOrder')
    expect(toposortPos).toBeGreaterThan(-1)
    // Both helpers should reference the clarify port names within their
    // first ~50 lines (skip / continue lines). Slice 4000 chars to give
    // generous room for either function's body.
    const buildScopeBody = src.slice(buildScopePos, buildScopePos + 4000)
    expect(buildScopeBody).toContain('__clarify__')
    const toposortBody = src.slice(toposortPos, toposortPos + 4000)
    expect(toposortBody).toContain('__clarify__')
  })
})
