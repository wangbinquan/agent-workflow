// RFC-371 incremental-query correction: new/revised facts replace their previous
// contribution. They must never invalidate or recount unrelated contributions.
import { expect, test } from 'bun:test'
import {
  addCompleteObservationAllocation,
  completeObservationMetrics,
  emptyCompleteObservationFold,
  mergeCompleteObservationFold,
  type CompleteObservationFold,
} from '@/modules/run-observability/domain/completeObservationMetrics'
import {
  completeIncrementalObservationFold,
  emptyIncrementalObservationFold,
  replaceIncrementalObservationContribution,
} from '@/modules/run-observability/domain/incrementalObservationFold'

function measured(input: string, amount: string | null = '0.000000000001') {
  const fold = emptyCompleteObservationFold('1')
  fold.observedInvocations = '1'
  addCompleteObservationAllocation(
    fold,
    { input, cacheRead: '0', cacheWrite: '0', output: '3' },
    { amount, complete: amount !== null, hidden: false },
  )
  return fold
}
function oracle(facts: readonly CompleteObservationFold[]) {
  const fold = emptyCompleteObservationFold()
  for (const fact of facts) mergeCompleteObservationFold(fold, fact)
  fold.gaps.sort()
  return completeObservationMetrics(fold)
}

test('more than one thousand contributions equal the original complete oracle after downward revision and removal', () => {
  const facts = Array.from({ length: 1007 }, (_, index) => measured(String(index + 1)))
  let state = emptyIncrementalObservationFold()
  for (const fact of facts) state = replaceIncrementalObservationContribution(state, null, fact)
  expect(completeObservationMetrics(completeIncrementalObservationFold(state))).toEqual(
    oracle(facts),
  )
  const old = facts[500]!,
    revised = measured('2', '0.000000000002')
  state = replaceIncrementalObservationContribution(state, old, revised)
  facts[500] = revised
  expect(completeObservationMetrics(completeIncrementalObservationFold(state))).toEqual(
    oracle(facts),
  )
  state = replaceIncrementalObservationContribution(state, facts[7]!, null)
  facts.splice(7, 1)
  expect(completeObservationMetrics(completeIncrementalObservationFold(state))).toEqual(
    oracle(facts),
  )
  expect(state.counters.invocations).toBe('1006')
  expect(state.tokens.input).toBe('507021')
})

test('repeated same-value contribution is a no-op and never changes its count', () => {
  const fact = measured('9')
  const current = replaceIncrementalObservationContribution(
    emptyIncrementalObservationFold(),
    null,
    fact,
  )
  expect(replaceIncrementalObservationContribution(current, fact, structuredClone(fact))).toBe(
    current,
  )
  expect(replaceIncrementalObservationContribution(current, null, null)).toBe(current)
  expect(current.counters.records).toBe('1')
})

test('late independent valuation changes only exact CNY, never Token or invocation population', () => {
  const usageOnly = measured('9007199254740993', null)
  const priced = measured('9007199254740993', '9007199254740993.123456789012')
  const old = replaceIncrementalObservationContribution(
    emptyIncrementalObservationFold(),
    null,
    usageOnly,
  )
  const next = replaceIncrementalObservationContribution(old, usageOnly, priced)
  expect(next.tokens).toEqual(old.tokens)
  expect(next.bucketRecords).toEqual(old.bucketRecords)
  expect(next.counters.records).toBe('1')
  expect(next.counters.invocations).toBe('1')
  expect(next.counters.picos).toBe('9007199254740993123456789012')
  expect(completeObservationMetrics(completeIncrementalObservationFold(next))).toEqual(
    oracle([priced]),
  )
})

test('repairing one of two contributors preserves shared gaps and the last repair restores complete coverage', () => {
  const gap = measured('11')
  gap.tokenCoverageKnown = false
  gap.visible = false
  gap.priced = false
  gap.gaps = ['source-incomplete', 'source-incomplete']
  const good = measured('11')
  let state = emptyIncrementalObservationFold()
  state = replaceIncrementalObservationContribution(state, null, gap)
  state = replaceIncrementalObservationContribution(state, null, gap)
  state = replaceIncrementalObservationContribution(state, gap, good)
  expect(state.gaps).toEqual({ 'source-incomplete': '1' })
  expect(state.unknownCoverage).toBe('1')
  expect(state.hidden).toBe('1')
  expect(state.unpriced).toBe('1')
  expect(completeObservationMetrics(completeIncrementalObservationFold(state))).toEqual(
    oracle([gap, good]),
  )
  state = replaceIncrementalObservationContribution(state, gap, good)
  expect(state.gaps).toEqual({})
  expect(state.unknownCoverage).toBe('0')
  expect(state.hidden).toBe('0')
  expect(state.unpriced).toBe('0')
  expect(completeObservationMetrics(completeIncrementalObservationFold(state))).toEqual(
    oracle([good, good]),
  )
})

test('a partial four-bucket revision retains known input/output and repairs only the previously unknown buckets', () => {
  const partial = emptyCompleteObservationFold('1')
  partial.observedInvocations = '1'
  addCompleteObservationAllocation(
    partial,
    { input: '13', cacheRead: null, cacheWrite: null, output: '7' },
    { amount: '0.02', complete: false, hidden: false },
  )
  const full = emptyCompleteObservationFold('1')
  full.observedInvocations = '1'
  addCompleteObservationAllocation(
    full,
    { input: '13', cacheRead: '17', cacheWrite: '19', output: '7' },
    { amount: '0.05', complete: true, hidden: false },
  )
  const old = replaceIncrementalObservationContribution(
    emptyIncrementalObservationFold(),
    null,
    partial,
  )
  expect(completeObservationMetrics(completeIncrementalObservationFold(old))).toEqual(
    oracle([partial]),
  )
  const next = replaceIncrementalObservationContribution(old, partial, full)
  expect(next.tokens).toEqual({ input: '13', cacheRead: '17', cacheWrite: '19', output: '7' })
  expect(next.counters.records).toBe('1')
  expect(completeObservationMetrics(completeIncrementalObservationFold(next))).toEqual(
    oracle([full]),
  )
})

test('unknown usage does not become zero and a proved zero invocation has its own coverage', () => {
  const unknown = emptyCompleteObservationFold('1')
  unknown.gaps = ['capture-missing']
  const zero = emptyCompleteObservationFold('1')
  zero.observedInvocations = '1'
  zero.knownZeroInvocations = '1'
  zero.knownZeroCostInvocations = '1'
  const old = replaceIncrementalObservationContribution(
    emptyIncrementalObservationFold(),
    null,
    unknown,
  )
  expect(completeObservationMetrics(completeIncrementalObservationFold(old))).toEqual(
    oracle([unknown]),
  )
  const next = replaceIncrementalObservationContribution(old, unknown, zero)
  expect(next.counters.records).toBe('0')
  expect(completeObservationMetrics(completeIncrementalObservationFold(next))).toEqual(
    oracle([zero]),
  )
})

test('historical references survive changing an accepted contribution, and removing all returns to not-applicable', () => {
  const historical = measured('23')
  historical.invocations = '0'
  historical.observedInvocations = '0'
  historical.historicalReferences = '1'
  historical.observedHistoricalReferences = '1'
  const accepted = measured('29')
  let state = replaceIncrementalObservationContribution(
    emptyIncrementalObservationFold(),
    null,
    historical,
  )
  state = replaceIncrementalObservationContribution(state, null, accepted)
  state = replaceIncrementalObservationContribution(state, accepted, null)
  expect(completeObservationMetrics(completeIncrementalObservationFold(state))).toEqual(
    oracle([historical]),
  )
  state = replaceIncrementalObservationContribution(state, historical, null)
  expect(completeObservationMetrics(completeIncrementalObservationFold(state))).toEqual({
    state: 'not-applicable',
  })
})

test('an invalid subtraction or malformed count fails atomically without mutating previous state', () => {
  const empty = emptyIncrementalObservationFold(),
    before = structuredClone(empty)
  expect(() => replaceIncrementalObservationContribution(empty, measured('1'), null)).toThrow(
    'underflow',
  )
  const bad = measured('1')
  bad.tokens.input = '-1'
  expect(() => replaceIncrementalObservationContribution(empty, null, bad)).toThrow(
    'nonnegative integers',
  )
  expect(empty).toEqual(before)
})
