// RFC-023 PR-C C6 — locks the two-edge invariant of the reverse-drag flow.
//
// Guard 1: buildClarifyEdges returns exactly two edges per call (literal-
// count assertion against the helper itself).
//
// Guard 2: scheduler.ts ignores the visual `clarify.answers → agent.__clarify_response__`
// edge when computing the projected dataflow upstreams — so deleting that
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
    // by name: `buildScopeUpstreams` is the single projected dependency
    // graph used by both frontier dispatch and cycle detection. It must
    // call the shared channel-edge policy rather than duplicating it.
    const buildScopePos = src.indexOf('function buildScopeUpstreams')
    expect(buildScopePos).toBeGreaterThan(-1)
    const buildScopeBody = src.slice(buildScopePos, buildScopePos + 4000)
    expect(buildScopeBody).toContain('channelEdgeDataflowSkip')
    expect(src).not.toContain('function topologicalOrder')
  })
})
