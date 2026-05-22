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
    // If a refactor drops the guard, the answers→agent edge becomes a hard
    // upstream dep and the cycle resolution breaks. We pin the mechanism
    // by name: the two places to guard are `buildScopeUpstreams` and
    // `topologicalOrder`. Both must explicitly skip clarify-channel
    // edges — historically that meant a literal `__clarify__` string in
    // the function body; post RFC-056 patch 2026-05-22 the shared helper
    // `isClarifyChannelEdge` (in shared/clarify-cross.ts) owns the rule
    // and both helpers call into it. Either shape counts as "guarded".
    const buildScopePos = src.indexOf('function buildScopeUpstreams')
    expect(buildScopePos).toBeGreaterThan(-1)
    const toposortPos = src.indexOf('function topologicalOrder')
    expect(toposortPos).toBeGreaterThan(-1)
    const buildScopeBody = src.slice(buildScopePos, buildScopePos + 4000)
    const toposortBody = src.slice(toposortPos, toposortPos + 4000)
    // Each body must contain SOME clarify-channel-edge skip signal:
    // either the literal `__clarify__` port name (legacy inline form) or
    // the shared `isClarifyChannelEdge` helper call (post-patch form).
    expect(
      buildScopeBody.includes('__clarify__') || buildScopeBody.includes('isClarifyChannelEdge'),
    ).toBe(true)
    expect(
      toposortBody.includes('__clarify__') || toposortBody.includes('isClarifyChannelEdge'),
    ).toBe(true)
  })
})
