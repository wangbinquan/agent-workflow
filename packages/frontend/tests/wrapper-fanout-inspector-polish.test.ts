// RFC-060 PR-F F.T1 → RFC-354 — wrapper-fanout NodeInspector polish.
//
// Source-text contract for the wrapper-fanout inspector branch:
//
//   1. Renders Field-based groups (RFC-035 public form primitive) for every
//      section — no naked <input>.
//   2. RFC-354 (schema v6): the fan-out's parameters are its inbound edges,
//      rendered read-only (name ← source, → boundary hand-off), and the only
//      editable fact is `shardSourcePort`, picked with the shared <Select>
//      among those parameter names. No `inputs[]` CRUD survives.
//   3. Renders the derived-outputs read-only section based on
//      `deriveWrapperFanoutOutputs` (so the user sees the wrapper's
//      runtime outlets — aggregator outputs OR the __done__ signal).
//
// Per CLAUDE.md "Frontend UI consistency" — wrapper-fanout MUST reuse
// `<Field>` / `<Select>` rather than emitting bespoke chrome. This lock makes
// a regression to naked `<input>` (or to a node-level port list) fail at CI.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const REPO = resolve(import.meta.dirname, '..', '..', '..')

// RFC-146 T3: the wrapper-fanout branch is its own component file now — the
// whole file IS the block (no more case-label slicing inside the switch).
const inspectorSrc = readFileSync(
  resolve(REPO, 'packages/frontend/src/components/canvas/inspector/WrapperFanoutEdit.tsx'),
  'utf-8',
)

describe('RFC-060 F.T1 / RFC-354 — wrapper-fanout inspector reuses public form primitives', () => {
  const block = inspectorSrc

  test('wrapper-fanout Edit component exists and is registered', () => {
    expect(block.length).toBeGreaterThan(100)
    const registry = readFileSync(
      resolve(REPO, 'packages/frontend/src/components/canvas/NodeInspector.tsx'),
      'utf-8',
    )
    expect(registry).toMatch(/'wrapper-fanout':\s*WrapperFanoutEdit/)
  })

  test('uses Field wrapper for every group (no naked DOM input)', () => {
    // Four Fields: innerNodeIds (read-only summary), fanoutParams (read-only
    // edge rows), fanoutShardSourcePort (the one editable fact),
    // fanoutDerivedOutputs (read-only).
    expect(block).toMatch(/<Field[\s\S]*?label=\{t\('inspector\.innerNodeIds'\)\}/)
    expect(block).toMatch(/<Field[\s\S]*?label=\{t\('inspector\.fanoutParams'\)\}/)
    expect(block).toMatch(/<Field[\s\S]*?label=\{t\('inspector\.fanoutShardSourcePort'\)\}/)
    expect(block).toMatch(/<Field[\s\S]*?label=\{t\('inspector\.fanoutDerivedOutputs'\)\}/)
    expect(block).not.toMatch(/<input\s/)
  })

  test('shardSourcePort is picked with the shared <Select> among the parameter (edge) names', () => {
    expect(block).toContain('<Select<string>')
    expect(block).toMatch(/data-testid="fanout-shard-source-select"/)
    expect(block).toMatch(/parameterNames\.map\(\(name\)\s*=>\s*\(\{\s*value:\s*name/)
    expect(block).toMatch(/\{\s*shardSourcePort:\s*next\s*\}/)
  })

  test('no node-level inputs[] declaration survives (parameters are edges)', () => {
    expect(block).not.toMatch(/\binputs\s*:/)
    expect(block).not.toMatch(/isShardSource/)
    expect(block).not.toMatch(/KindSelect|<Switch/)
    expect(block).toMatch(/edge\.boundary === undefined/)
  })

  test('derived outputs render the result of deriveWrapperFanoutOutputs', () => {
    expect(block).toContain('deriveWrapperFanoutOutputs(')
    // The derivedOutputs list renders each port's name + kind.
    expect(block).toMatch(/derivedOutputs\.map\(\(o\)\s*=>/)
  })
})
