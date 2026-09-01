// RFC-056 PR-D C6 — 7-validator-rules enumeration 守门.
//
// RFC-056 §2.1.15 declares 7 validator rules guarding cross-clarify node
// configuration (3 fail + 4 warning). Each must be checked at workflow
// validation time, and each must have at least one positive test in
// `workflow-validator-cross-clarify-rfc056.test.ts`. If a rule gets
// renamed, removed, or silently un-checked the validator can accept
// misconfigurations that crash submit / cascade at runtime; this meta-
// test pins both the validator source text AND the test-suite coverage
// by rule code.
//
// LOCKS:
//   1. All 7 rule codes are referenced by literal in
//      `packages/backend/src/modules/resource-catalog/infrastructure/legacy/workflow.validator.ts`.
//   2. All 7 rule codes appear as `toContain('<code>')` assertions in
//      `packages/backend/tests/workflow-validator-cross-clarify-rfc056.test.ts`.
//   3. The literal `topology-cycle` whitelist exemption for cross-clarify
//      is present in the validator (cross-clarify forms intentional
//      feedback cycles, which must NOT trip topology-cycle).
//
// If any of these go red the 7-rule contract has drifted — investigate
// before relaxing.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const BACKEND_ROOT = resolve(import.meta.dir, '..')
const VALIDATOR_TS = resolve(
  BACKEND_ROOT,
  'src',
  'modules',
  'resource-catalog',
  'infrastructure',
  'legacy',
  'workflow.validator.ts',
)
const VALIDATOR_TEST_TS = resolve(
  BACKEND_ROOT,
  'tests',
  'workflow-validator-cross-clarify-rfc056.test.ts',
)

const CROSS_CLARIFY_RULE_CODES = [
  // FAIL (5) — RFC-056 §2.1.15 originally shipped 3 fail codes; RFC-063 adds 2
  // multiplicity rules (G2 + G3) that lift "1 questioner / 1 designer per
  // cross-clarify" from an implicit design assumption to a hard schema-time
  // constraint.
  'cross-clarify-input-source-missing',
  'cross-clarify-target-not-agent-single',
  'cross-clarify-has-downstream',
  'cross-clarify-multiple-questioners', // RFC-063 G2
  'cross-clarify-multiple-designers', // RFC-063 G3
  // WARNING (5) — RFC-056 §2.1.15 originally shipped 4 warnings (3 fail + 4
  // warning = 7); `cross-clarify-no-iteration-cap` is a post-RFC patch that
  // mirrors RFC-023's same-node `clarify-no-iteration-cap` so the inspector's
  // wrapper-loop status chip is backed by the same rule on both clarify kinds.
  'cross-clarify-manual-edge-missing',
  'cross-clarify-target-not-ancestor',
  'cross-clarify-auto-edge-deleted',
  'cross-clarify-self-review-warning',
  'cross-clarify-no-iteration-cap',
] as const

describe('RFC-056 C6 — cross-clarify validator rules enumeration', () => {
  test('cross-clarify rules: 5 fail + 5 warning (RFC-056 §2.1.15 contract + no-iteration-cap patch + RFC-063 G2/G3)', () => {
    expect(CROSS_CLARIFY_RULE_CODES).toHaveLength(10)
  })

  for (const code of CROSS_CLARIFY_RULE_CODES) {
    test(`validator source references rule code: ${code}`, () => {
      const src = readFileSync(VALIDATOR_TS, 'utf-8')
      expect(src).toContain(code)
    })

    test(`validator test suite covers rule code: ${code}`, () => {
      const src = readFileSync(VALIDATOR_TEST_TS, 'utf-8')
      expect(src).toContain(code)
    })
  }

  test('topology-cycle whitelist exemption for cross-clarify is present in the validator', () => {
    const src = readFileSync(VALIDATOR_TS, 'utf-8')
    // We expect either a `topology-cycle` reference with a `clarify-cross-agent`
    // exemption nearby, or a dedicated comment/code path. Pinning both literals
    // is a thin proxy that catches both rename and removal.
    expect(src).toContain('topology-cycle')
    expect(src).toContain('clarify-cross-agent')
  })
})
