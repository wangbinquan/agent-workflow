// RFC-060 PR-F F.T1 — wrapper-fanout NodeInspector polish.
//
// Source-text contract for the wrapper-fanout inspector branch:
//
//   1. Renders Field-based inputs (RFC-035 public form primitive) for
//      every editable wrapper-fanout field — no naked <input>.
//   2. Renders the `Field` for fanout inputs[] CRUD (add / remove + name /
//      kind + isShardSource toggle).
//   3. Renders the derived-outputs read-only section based on
//      `deriveWrapperFanoutOutputs` (so the user sees the wrapper's
//      runtime outlets — aggregator outputs OR the __done__ signal).
//   4. shardSource Switch enforces the singleton invariant: enabling on
//      one input clears the flag on the others (source-text lock on the
//      patchInputs callback).
//
// Per CLAUDE.md "Frontend UI consistency" — wrapper-fanout MUST reuse
// `<Field>` / `<TextInput>` / `<Switch>` rather than emitting bespoke
// chrome. This lock makes a regression to naked `<input>` fail at CI.

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

function wrapperFanoutBlock(): string {
  return inspectorSrc
}

describe('RFC-060 F.T1 — wrapper-fanout inspector reuses public form primitives', () => {
  const block = wrapperFanoutBlock()

  test('wrapper-fanout Edit component exists and is registered', () => {
    expect(block.length).toBeGreaterThan(100)
    const registry = readFileSync(
      resolve(REPO, 'packages/frontend/src/components/canvas/NodeInspector.tsx'),
      'utf-8',
    )
    expect(registry).toMatch(/'wrapper-fanout':\s*WrapperFanoutEdit/)
  })

  test('uses Field wrapper for every editable group (no naked DOM input)', () => {
    // Three Fields: innerNodeIds (read-only summary), fanoutInputs (CRUD),
    // fanoutDerivedOutputs (read-only).
    expect(block).toMatch(/<Field[\s\S]*?label=\{t\('inspector\.innerNodeIds'\)\}/)
    expect(block).toMatch(/<Field[\s\S]*?label=\{t\('inspector\.fanoutInputs'\)\}/)
    expect(block).toMatch(/<Field[\s\S]*?label=\{t\('inspector\.fanoutDerivedOutputs'\)\}/)
  })

  test('inputs[] row uses <TextInput> for name + <KindSelect> for kind (not raw <input>)', () => {
    // RFC-080 PR-B: the kind editor is the shared KindSelect (replaces the raw
    // kind <TextInput>); the name field stays a <TextInput>.
    expect(block).toContain('<TextInput')
    expect(block).toContain('<KindSelect')
    // Naked <input is allowed only on the shardSource <Switch> implementation
    // itself; the wrapper-fanout branch should NOT introduce any.
    expect(block).not.toMatch(/<input\s[^>]*className="form-input"/)
  })

  test('shardSource toggle uses <Switch> with singleton-invariant patch', () => {
    expect(block).toContain('<Switch')
    // Patch maps over the inputs and sets isShardSource: i === idx ? v : false
    expect(block).toMatch(/isShardSource:\s*i\s*===\s*idx\s*\?\s*v\s*:\s*false/)
  })

  test('derived outputs render the result of deriveWrapperFanoutOutputs', () => {
    expect(block).toContain('deriveWrapperFanoutOutputs(')
    // The derivedOutputs list renders each port's name + kind.
    expect(block).toMatch(/derivedOutputs\.map\(\(o\)\s*=>/)
  })

  test('add-input fallback marks the first input as shardSource when none is set', () => {
    expect(block).toMatch(/!inputsList\.some\(\(p\)\s*=>\s*p\.isShardSource\s*===\s*true\)/)
  })
})
