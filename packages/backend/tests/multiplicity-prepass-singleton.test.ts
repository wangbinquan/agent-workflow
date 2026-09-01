// RFC-069 C3 — pre-pass single-source-of-truth grep guard.
//
// The whole point of RFC-069 is that the three agent-level clarify attachment
// multiplicity rules live in EXACTLY ONE place — the pre-pass function
// `validateAgentClarifyMultiplicity` — instead of being duplicated across §4c
// and §4d case blocks. If a future refactor accidentally re-adds a rule body
// inside the case blocks (or fails to remove the new pre-pass after deleting
// the old body), this test catches the drift at lint-time rather than waiting
// for a runtime double-report or silent-miss regression.
//
// The grep below pins three invariants:
//
//   1. `validateAgentClarifyMultiplicity` function definition exists exactly
//      once in workflow.validator.ts (no accidental dual definition / no
//      accidental deletion).
//   2. Each of the three multiplicity rule codes is `issues.push`-ed exactly
//      once across the validator source (the pre-pass body — the old §4c/§4d
//      emitters have been deleted).
//   3. G3 `cross-clarify-multiple-designers` is still pushed inside the
//      validator (it intentionally stayed in §4d — not an agent attachment
//      rule, it governs to_designer multiplicity).
//
// If any of these go red the validator structure has drifted from RFC-069 —
// investigate before relaxing.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const VALIDATOR_TS = resolve(
  import.meta.dir,
  '..',
  'src',
  'modules',
  'resource-catalog',
  'infrastructure',
  'legacy',
  'workflow.validator.ts',
)

describe('RFC-069 C3 — pre-pass single source of truth grep guard', () => {
  test('validateAgentClarifyMultiplicity is defined exactly once', () => {
    const src = readFileSync(VALIDATOR_TS, 'utf-8')
    const defMatches = src.match(/export function validateAgentClarifyMultiplicity\b/g) ?? []
    expect(defMatches).toHaveLength(1)
  })

  test('clarify-multiple-clarify-on-same-agent is pushed exactly once (pre-pass body)', () => {
    const src = readFileSync(VALIDATOR_TS, 'utf-8')
    const pushMatches = src.match(/code: 'clarify-multiple-clarify-on-same-agent'/g) ?? []
    expect(pushMatches).toHaveLength(1)
  })

  test('clarify-multiple-source-agents is pushed exactly once (pre-pass body)', () => {
    const src = readFileSync(VALIDATOR_TS, 'utf-8')
    const pushMatches = src.match(/code: 'clarify-multiple-source-agents'/g) ?? []
    expect(pushMatches).toHaveLength(1)
  })

  test('cross-clarify-multiple-questioners is pushed exactly once (pre-pass body)', () => {
    const src = readFileSync(VALIDATOR_TS, 'utf-8')
    const pushMatches = src.match(/code: 'cross-clarify-multiple-questioners'/g) ?? []
    expect(pushMatches).toHaveLength(1)
  })

  test('G3 cross-clarify-multiple-designers stays in §4d (intentionally not moved)', () => {
    const src = readFileSync(VALIDATOR_TS, 'utf-8')
    const pushMatches = src.match(/code: 'cross-clarify-multiple-designers'/g) ?? []
    expect(pushMatches).toHaveLength(1)
  })
})
