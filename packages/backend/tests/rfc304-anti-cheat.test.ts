// RFC-304 §6.4 T53 — did the "fix" fix anything, or just stop asking?
//
// The cheapest way to make a red pipeline green is to delete the test. An agent
// told to make CI pass will find that path, and the result looks like success:
// green pipeline, small diff, plausible justification.
//
// This file tests the honest half of the answer. A program can see that an
// assertion was removed; it cannot see whether removing it was right. So the
// signals are a SIGNAL, and what adjudicates is the red-before/green-after
// evidence — a fact anyone can re-run rather than the agent's account of
// itself.
//
// The property the tests care about most is what happens when the evidence is
// missing: NOT rejected (some tests genuinely should go) and NOT pushed (the
// platform has no basis to decide). The design is explicit that the hard block
// exists for "do not push automatically", never for "this justification is
// false" — and it called out the first draft, which failed a round for an empty
// justification field, as a soft constraint dressed up as a hard check.

import { describe, expect, test } from 'bun:test'
import {
  findCheatSignals,
  isTestPath,
  judgeAntiCheat,
  type CheatSignal,
} from '../src/modules/code-capability/domain/antiCheat'

const diff = (file: string, hunk: string[]): string =>
  [`--- a/${file}`, `+++ b/${file}`, '@@ -1,10 +1,10 @@', ...hunk].join('\n')

describe('RFC-304 T53 — which files count as tests', () => {
  test('the usual layouts are recognised', () => {
    for (const path of [
      'packages/backend/tests/thing.test.ts',
      'src/__tests__/thing.spec.tsx',
      'e2e/flow.spec.ts',
      'spec/models/user_spec.rb',
      'internal/server/server_test.go',
      'tests/test_retry.py',
      'test/helpers.js',
    ]) {
      expect(isTestPath(path), path).toBe(true)
    }
  })

  test('production code is not', () => {
    // An assertion removed from production code is ordinary refactoring.
    // Conflating the two would flag half of all honest changes and train the
    // reader to ignore this check.
    for (const path of ['src/retry.ts', 'packages/backend/src/services/task.ts', 'README.md']) {
      expect(isTestPath(path), path).toBe(false)
    }
  })
})

describe('RFC-304 T53 — the structural signals', () => {
  test('a removed assertion in a test file is flagged', () => {
    const signals = findCheatSignals(
      diff('tests/retry.test.ts', ['   const out = retry()', '-  expect(out.attempts).toBe(3)']),
    )
    expect(signals.map((s) => s.kind)).toEqual(['assertion-removed'])
    expect(signals[0]?.detail).toContain('expect(out.attempts)')
  })

  test('a removed assertion in PRODUCTION code is not', () => {
    const signals = findCheatSignals(
      diff('src/retry.ts', ['-  assert(attempts <= 3)', '   return result']),
    )
    expect(signals).toEqual([])
  })

  test('an added skip is flagged', () => {
    expect(
      findCheatSignals(
        diff('tests/retry.test.ts', [
          '-  test("retries three times", () => {',
          '+  test.skip("retries three times", () => {',
        ]),
      ).some((s) => s.kind === 'test-skipped'),
    ).toBe(true)
  })

  test('skips are recognised across ecosystems', () => {
    for (const line of [
      '+  @pytest.mark.skip',
      '+  t.Skip("flaky")',
      '+  #[ignore]',
      '+  xit("does the thing", () => {',
    ]) {
      const signals = findCheatSignals(diff('tests/x_test.go', [line]))
      expect(
        signals.some((s) => s.kind === 'test-skipped'),
        line,
      ).toBe(true)
    }
  })

  test('a test file that shrank a lot is flagged', () => {
    const hunk = ['+  const x = 1']
    for (let i = 0; i < 8; i += 1) hunk.push(`-  const removed${String(i)} = ${String(i)}`)
    const signals = findCheatSignals(diff('tests/retry.test.ts', hunk))
    expect(signals.some((s) => s.kind === 'tests-shrunk')).toBe(true)
  })

  test('a small tidy-up is NOT flagged as shrinkage', () => {
    // Tidying an import or collapsing a fixture legitimately removes lines. A
    // check that fires on every one of those stops being read.
    const signals = findCheatSignals(
      diff('tests/retry.test.ts', ['-import { unused } from "./x"', '-', '   const a = 1']),
    )
    expect(signals.some((s) => s.kind === 'tests-shrunk')).toBe(false)
  })

  test('a loosened threshold is flagged', () => {
    const signals = findCheatSignals(
      diff('tests/perf.test.ts', [
        '-  expect(elapsed).toBeLessThan(100)',
        '+  expect(elapsed).toBeLessThan(10000)',
      ]),
    )
    expect(signals.some((s) => s.kind === 'assertion-loosened')).toBe(true)
    expect(signals.find((s) => s.kind === 'assertion-loosened')?.detail).toContain('10000')
  })

  test('an assertion rewritten in a different SHAPE is not read as loosening', () => {
    // Pairing on "identical except for the numbers" is what keeps this from
    // flagging every honest update to an expected value.
    const signals = findCheatSignals(
      diff('tests/x.test.ts', [
        '-  expect(result).toBe(3)',
        '+  expect(result.attempts).toEqual({ tried: 3 })',
      ]),
    )
    expect(signals.some((s) => s.kind === 'assertion-loosened')).toBe(false)
  })

  test('an honest test change produces no signals at all', () => {
    const signals = findCheatSignals(
      diff('tests/retry.test.ts', [
        '   const out = retry()',
        '+  expect(out.lastError).not.toBeNull()',
      ]),
    )
    expect(signals).toEqual([])
  })

  test('a malformed diff yields no signals rather than throwing', () => {
    // Refusing to analyse is the one outcome that would let a deleted test
    // through silently, so this must never be an exception.
    expect(() => findCheatSignals('not a diff at all')).not.toThrow()
    expect(findCheatSignals('')).toEqual([])
  })
})

describe('RFC-304 T53 — what the platform DECIDES on', () => {
  const signals: CheatSignal[] = [
    { kind: 'assertion-removed', file: 'tests/retry.test.ts', detail: 'expect(x).toBe(3)' },
  ]

  test('no signals: allowed, whatever the evidence says', () => {
    expect(judgeAntiCheat([], { kind: 'inconclusive', reason: 'no test runner' }).decision).toBe(
      'allow',
    )
  })

  test('red before, green after: ALLOWED even though coverage changed', () => {
    // The test failed and now passes. Whatever it did to the file, it fixed the
    // thing the test was checking — and that is a fact, not a claim.
    const verdict = judgeAntiCheat(signals, { kind: 'red-before-green-after' })
    expect(verdict.decision).toBe('allow')
  })

  test('already green on the baseline: REJECTED', () => {
    // The strongest possible evidence that the "fix" is not one: this change is
    // what broke or removed a test that was passing.
    const verdict = judgeAntiCheat(signals, { kind: 'was-already-green' })
    expect(verdict.decision).toBe('reject')
    expect(verdict.decision === 'reject' && verdict.message).toContain('already passing')
    // The reviewer is told exactly what was seen.
    expect(verdict.decision === 'reject' && verdict.message).toContain('tests/retry.test.ts')
  })

  test('inconclusive: NEITHER rejected NOR pushed', () => {
    // The case the whole design section is about. Some tests genuinely should
    // be deleted, so rejecting would be wrong; the platform has no basis to
    // approve, so pushing would be worse. A person looks.
    const verdict = judgeAntiCheat(signals, {
      kind: 'inconclusive',
      reason: 'the test needs a live database',
    })
    expect(verdict.decision).toBe('escalate')
    expect(verdict.decision === 'escalate' && verdict.message).toContain('Nothing was pushed')
    expect(verdict.decision === 'escalate' && verdict.message).toContain('live database')
  })

  test('a justification is NEVER consulted — there is nowhere to pass one', () => {
    // The failure the design called out in its own first draft: requiring a
    // justification field and checking it is non-empty hands the decision back
    // to the agent's account of itself. The agent writes a paragraph and
    // passes. This function's signature is the guard — it takes signals and
    // evidence, and there is no third argument for prose.
    expect(judgeAntiCheat.length).toBe(2)
  })
})
