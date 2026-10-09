import { expect, test } from 'bun:test'
import type { CompleteObservationMetrics } from '@agent-workflow/shared'
import {
  addCompleteObservationAllocation,
  completeObservationGap,
  completeObservationMetrics,
  emptyCompleteObservationFold,
  mergeCompleteObservationFold,
} from '@/modules/run-observability/domain/completeObservationMetrics'
import { completeMetricsFold } from '@/modules/run-observability/domain/completeMetricsFold'
import { qualifiedCostEvidence } from '@/modules/run-observability/domain/completeReportFacts'

const usage = { input: '1', cacheRead: '2', cacheWrite: '0', output: '3' }
const tokenCoverage = (invocations: string, observedInvocations: string, records: string) => ({
  invocations,
  observedInvocations,
  records,
  bucketRecords: { input: records, cacheRead: records, cacheWrite: records, output: records },
})

test('a received unpriced invocation preserves its two records when aggregated with one priced record', () => {
  const unpriced = emptyCompleteObservationFold('1')
  for (let i = 0; i < 2; i++)
    addCompleteObservationAllocation(unpriced, usage, {
      amount: null,
      complete: false,
      hidden: false,
    })
  unpriced.observedInvocations = '1'
  completeObservationGap(unpriced, 'native-capture-unobserved')
  const original = completeObservationMetrics(unpriced)
  expect(original).toEqual({
    state: 'not-ready',
    gaps: ['native-capture-unobserved'],
    costCoverage: { records: '2', pricedRecords: '0', visibility: 'visible' },
    tokenCoverage: tokenCoverage('1', '1', '2'),
    recordedUsage: {
      ...tokenCoverage('1', '1', '2'),
      tokens: { input: '2', cacheRead: '4', cacheWrite: '0', output: '6', total: '12' },
    },
  })
  const restored = completeMetricsFold(original)
  expect(restored.costRecords).toBe('2')
  expect(restored.pricedRecords).toBe('0')
  expect(restored.records).toBe('2')
  expect(restored.invocations).toBe('1')
  expect(restored.observedInvocations).toBe('1')
  expect(restored.tokens).toEqual({ input: '2', cacheRead: '4', cacheWrite: '0', output: '6' })
  // The same original Token population survives before any parent dimension merge.
  const priced = emptyCompleteObservationFold('1')
  addCompleteObservationAllocation(priced, usage, {
    amount: '0.02',
    complete: true,
    hidden: false,
  })
  priced.observedInvocations = '1'
  const combined = emptyCompleteObservationFold()
  mergeCompleteObservationFold(combined, completeMetricsFold(completeObservationMetrics(priced)))
  mergeCompleteObservationFold(combined, restored)
  const value = completeObservationMetrics(combined)
  expect(value).toEqual({
    state: 'not-ready',
    gaps: ['native-capture-unobserved'],
    costCoverage: { records: '3', pricedRecords: '1', visibility: 'visible' },
    tokenCoverage: tokenCoverage('2', '2', '3'),
    recordedUsage: {
      ...tokenCoverage('2', '2', '3'),
      tokens: { input: '3', cacheRead: '6', cacheWrite: '0', output: '9', total: '18' },
    },
    recordedCost: { currency: 'CNY', amount: '0.02', records: '3', pricedRecords: '1' },
  })
  expect(value).not.toHaveProperty('tokens')
  expect(value).not.toHaveProperty('cost')
  expect(qualifiedCostEvidence(value)).toBe(true)
  expect(completeObservationMetrics(completeMetricsFold(value))).toEqual(value)
})

test('complete Token evidence with mixed pricing retains every priced CNY contribution', () => {
  const fold = emptyCompleteObservationFold('1')
  addCompleteObservationAllocation(fold, usage, {
    amount: '0.000000000001',
    complete: true,
    hidden: false,
  })
  addCompleteObservationAllocation(fold, usage, {
    amount: null,
    complete: false,
    hidden: false,
  })
  fold.observedInvocations = '1'
  const value = completeObservationMetrics(fold)
  expect(value.state).toBe('ready')
  if (value.state !== 'ready') throw new Error('Original Token evidence lost')
  expect(value.tokens).toEqual({
    input: '2',
    cacheRead: '4',
    cacheWrite: '0',
    output: '6',
    total: '12',
  })
  expect(value.cost).toEqual({ currency: 'CNY', state: 'unpriced', amount: null })
  expect(value.recordedCost).toEqual({
    currency: 'CNY',
    amount: '0.000000000001',
    records: '2',
    pricedRecords: '1',
  })
  expect(qualifiedCostEvidence(value)).toBe(true)
  expect(completeObservationMetrics(completeMetricsFold(value))).toEqual(value)
})

test('hidden incomplete cost stays hidden through restoration and aggregation', () => {
  const hidden = emptyCompleteObservationFold('1')
  addCompleteObservationAllocation(hidden, usage, { amount: null, complete: false, hidden: true })
  completeObservationGap(hidden, 'native-capture-unobserved')
  const original = completeObservationMetrics(hidden)
  expect(original).toEqual({
    state: 'not-ready',
    gaps: ['native-capture-unobserved'],
    costCoverage: { records: '1', pricedRecords: '0', visibility: 'hidden' },
    tokenCoverage: tokenCoverage('1', '0', '1'),
    recordedUsage: { ...tokenCoverage('1', '0', '1'), tokens: { ...usage, total: '6' } },
  })
  const restored = completeMetricsFold(original)
  expect(restored.visible).toBe(false)
  addCompleteObservationAllocation(restored, usage, { amount: '7', complete: true, hidden: false })
  const combined = completeObservationMetrics(restored)
  expect(combined).not.toHaveProperty('recordedCost')
  expect(combined).not.toHaveProperty('cost')
  if (combined.state !== 'not-ready') throw new Error('Original hidden scope lost')
  expect(combined.costCoverage).toEqual({ records: '2', pricedRecords: '1', visibility: 'hidden' })
  expect(qualifiedCostEvidence(combined)).toBe(true)
})

test('a complete zero-record platform invocation with pending costs does not reject another priced contribution', () => {
  // Original platform capture can prove zero steps while its valuation is not ready.
  // The Task fold then has known-zero Token evidence and priced=false, with no usage gap.
  const platform = emptyCompleteObservationFold('1')
  platform.observedInvocations = '1'
  platform.priced = false
  const zero = completeObservationMetrics(platform)
  expect(zero.state).toBe('ready')
  if (zero.state !== 'ready') throw new Error('Original known-zero Token evidence lost')
  expect(zero.records).toBe('0')
  expect(zero.tokens.total).toBe('0')
  expect(zero.cost).toEqual({ currency: 'CNY', state: 'unpriced', amount: null })
  const priced = emptyCompleteObservationFold('1')
  priced.observedInvocations = '1'
  addCompleteObservationAllocation(priced, usage, {
    amount: '0.02',
    complete: true,
    hidden: false,
  })
  const combined = emptyCompleteObservationFold()
  mergeCompleteObservationFold(combined, completeMetricsFold(zero))
  mergeCompleteObservationFold(combined, completeMetricsFold(completeObservationMetrics(priced)))
  const value = completeObservationMetrics(combined)
  expect(value.state).toBe('ready')
  if (value.state !== 'ready') throw new Error('Original complete Token qualification lost')
  expect(value.invocations).toBe('2')
  expect(value.observedInvocations).toBe('2')
  expect(value.records).toBe('1')
  expect(value.tokens).toEqual({ ...usage, total: '6' })
  expect(value.cost).toEqual({ currency: 'CNY', state: 'unpriced', amount: null })
  expect(value.recordedCost).toEqual({
    currency: 'CNY',
    amount: '0.02',
    records: '1',
    pricedRecords: '1',
  })
  expect(qualifiedCostEvidence(value)).toBe(true)
  expect(completeObservationMetrics(completeMetricsFold(value))).toEqual(value)
  expect(
    qualifiedCostEvidence({
      ...value,
      recordedCost: { ...value.recordedCost!, pricedRecords: '2' },
    }),
  ).toBe(false)
})

test('a proven zero CNY quote is distinct from receiving records without any quote', () => {
  for (const priced of [false, true]) {
    const fold = emptyCompleteObservationFold('1')
    addCompleteObservationAllocation(fold, usage, {
      amount: priced ? '0' : null,
      complete: priced,
      hidden: false,
    })
    completeObservationGap(fold, 'native-capture-unobserved')
    const value = completeObservationMetrics(fold)
    if (value.state !== 'not-ready') throw new Error('Original incomplete scope lost')
    expect(value.costCoverage?.pricedRecords).toBe(priced ? '1' : '0')
    expect(value.recordedCost).toEqual(
      priced ? { currency: 'CNY', amount: '0', records: '1', pricedRecords: '1' } : undefined,
    )
    expect(qualifiedCostEvidence(value)).toBe(true)
  }
})

test('recorded cost rejects invented currency, hidden amounts, inconsistent populations and precision', () => {
  const original: CompleteObservationMetrics = {
    state: 'not-ready',
    gaps: ['usage-unobserved'],
    costCoverage: { records: '3', pricedRecords: '1', visibility: 'visible' },
    recordedCost: { currency: 'CNY', amount: '0.02', records: '3', pricedRecords: '1' },
  }
  expect(qualifiedCostEvidence(original)).toBe(true)
  const withoutCost = { ...original, recordedCost: undefined }
  expect(qualifiedCostEvidence(withoutCost)).toBe(false)
  for (const change of [
    { costCoverage: { records: '03', pricedRecords: '1', visibility: 'visible' } },
    { costCoverage: { records: '3', pricedRecords: '4', visibility: 'visible' } },
    { costCoverage: { records: '3', pricedRecords: '1', visibility: 'hidden' } },
    { costCoverage: undefined },
    { recordedCost: { ...original.recordedCost, currency: 'USD' } },
    { recordedCost: { ...original.recordedCost, amount: '-1' } },
    { recordedCost: { ...original.recordedCost, amount: '2e-2' } },
    { recordedCost: { ...original.recordedCost, amount: '0.020' } },
    { recordedCost: { ...original.recordedCost, amount: '0.0000000000001' } },
    { recordedCost: { ...original.recordedCost, records: '2' } },
    { recordedCost: { ...original.recordedCost, pricedRecords: '0' } },
    { recordedCost: { ...original.recordedCost, tax: '1' } },
  ])
    expect(qualifiedCostEvidence({ ...original, ...change } as CompleteObservationMetrics)).toBe(
      false,
    )
})

// RFC-371 known-zero-recorded-metrics: complete empty native captures are known
// contributions, even when other original calls still have no usage evidence.
const completeEmptyCalls: CompleteObservationMetrics = {
  state: 'ready',
  invocations: '64',
  observedInvocations: '64',
  records: '0',
  tokens: { input: '0', cacheRead: '0', cacheWrite: '0', output: '0', total: '0' },
  cost: { currency: 'CNY', state: 'complete', amount: '0' },
}
const mergeEmptyWithUnknown = (zero = completeEmptyCalls) => {
  const unknown = emptyCompleteObservationFold('48')
  completeObservationGap(unknown, 'native-capture-unobserved')
  completeObservationGap(unknown, 'usage-unobserved')
  const fold = completeMetricsFold(zero)
  mergeCompleteObservationFold(fold, unknown)
  return completeObservationMetrics(fold)
}
test('64 complete empty calls retain four known zero buckets and zero CNY beside 48 unknown calls', () => {
  const value = mergeEmptyWithUnknown()
  const coverage = { ...tokenCoverage('112', '64', '0'), knownZeroInvocations: '64' }
  expect(value).toEqual({
    state: 'not-ready',
    gaps: ['native-capture-unobserved', 'usage-unobserved'],
    tokenCoverage: coverage,
    recordedUsage: { ...coverage, tokens: completeEmptyCalls.tokens },
    costCoverage: {
      records: '0',
      pricedRecords: '0',
      knownZeroCostInvocations: '64',
      visibility: 'visible',
    },
    recordedCost: {
      currency: 'CNY',
      amount: '0',
      records: '0',
      pricedRecords: '0',
      knownZeroCostInvocations: '64',
    },
  })
  expect(qualifiedCostEvidence(value)).toBe(true)
  expect(completeObservationMetrics(completeMetricsFold(value))).toEqual(value)
  expect(completeObservationMetrics(completeMetricsFold(completeEmptyCalls))).toEqual(
    completeEmptyCalls,
  )
})
test('old incomplete zero-record coverage does not invent empty-capture proof', () => {
  const old: CompleteObservationMetrics = {
    state: 'not-ready',
    gaps: ['native-capture-unobserved'],
    tokenCoverage: tokenCoverage('1', '1', '0'),
  }
  const restored = completeObservationMetrics(completeMetricsFold(old))
  expect(restored).toEqual(old)
  expect(restored).not.toHaveProperty('recordedUsage')
  expect(restored).not.toHaveProperty('recordedCost')
  expect(qualifiedCostEvidence(restored)).toBe(true)
})
test('platform empty Token proof with pending or hidden valuation never invents visible zero CNY', () => {
  for (const state of ['unpriced', 'hidden'] as const) {
    const zero: CompleteObservationMetrics = {
      ...completeEmptyCalls,
      cost: { currency: 'CNY', state, amount: null },
    }
    const value = mergeEmptyWithUnknown(zero)
    expect(value).toMatchObject({
      state: 'not-ready',
      tokenCoverage: { knownZeroInvocations: '64' },
      recordedUsage: { tokens: completeEmptyCalls.tokens },
    })
    expect(value).not.toHaveProperty('recordedCost')
    if (value.state !== 'not-ready') throw new Error('Unknown original calls were removed')
    expect(value.costCoverage?.knownZeroCostInvocations).toBeUndefined()
    if (state === 'hidden') expect(value.costCoverage?.visibility).toBe('hidden')
    expect(qualifiedCostEvidence(value)).toBe(true)
    expect(completeObservationMetrics(completeMetricsFold(value))).toEqual(value)
  }
})
test('empty proof keeps original partial Token and CNY sums without manufacturing numeric records', () => {
  const partial = emptyCompleteObservationFold('1')
  partial.observedInvocations = '1'
  addCompleteObservationAllocation(
    partial,
    { input: '120', cacheRead: null, cacheWrite: '0', output: null },
    { amount: '0.00012', complete: false, hidden: false },
  )
  mergeCompleteObservationFold(partial, completeMetricsFold(mergeEmptyWithUnknown()))
  const value = completeObservationMetrics(partial)
  expect(value).toMatchObject({
    state: 'not-ready',
    tokenCoverage: {
      invocations: '113',
      observedInvocations: '65',
      knownZeroInvocations: '64',
      records: '1',
      bucketRecords: { input: '1', cacheRead: '0', cacheWrite: '1', output: '0' },
    },
    recordedUsage: {
      tokens: { input: '120', cacheRead: '0', cacheWrite: '0', output: '0', total: '120' },
    },
    recordedCost: {
      currency: 'CNY',
      amount: '0.00012',
      records: '1',
      pricedRecords: '0',
      partiallyPricedRecords: '1',
      knownZeroCostInvocations: '64',
    },
  })
  if (value.state !== 'not-ready') throw new Error('Original gaps lost')
  expect(value.gaps).toEqual(['usage-incomplete', 'native-capture-unobserved', 'usage-unobserved'])
  expect(qualifiedCostEvidence(value)).toBe(true)
  expect(completeObservationMetrics(completeMetricsFold(value))).toEqual(value)
})
test('visible empty cost proof survives a ready scope with other fully observed but unpriced records', () => {
  const fold = completeMetricsFold(completeEmptyCalls)
  const unpriced = emptyCompleteObservationFold('1')
  unpriced.observedInvocations = '1'
  addCompleteObservationAllocation(unpriced, usage, {
    amount: null,
    complete: false,
    hidden: false,
  })
  mergeCompleteObservationFold(fold, unpriced)
  const value = completeObservationMetrics(fold)
  expect(value).toMatchObject({
    state: 'ready',
    invocations: '65',
    observedInvocations: '65',
    records: '1',
    tokens: { ...usage, total: '6' },
    cost: { currency: 'CNY', state: 'unpriced', amount: null },
    recordedCost: {
      currency: 'CNY',
      amount: '0',
      records: '1',
      pricedRecords: '0',
      knownZeroCostInvocations: '64',
    },
  })
  expect(qualifiedCostEvidence(value)).toBe(true)
  expect(completeObservationMetrics(completeMetricsFold(value))).toEqual(value)
})
test('zero-evidence counters and zero-only amount must match the original observed population', () => {
  const value = mergeEmptyWithUnknown()
  if (value.state !== 'not-ready' || !value.recordedUsage || !value.recordedCost)
    throw new Error('Known original zero contributions lost')
  for (const count of ['0', '064', '-1', '65']) {
    expect(
      qualifiedCostEvidence({
        ...value,
        tokenCoverage: { ...value.tokenCoverage!, knownZeroInvocations: count },
        recordedUsage: { ...value.recordedUsage, knownZeroInvocations: count },
      }),
    ).toBe(false)
    expect(
      qualifiedCostEvidence({
        ...value,
        costCoverage: { ...value.costCoverage!, knownZeroCostInvocations: count },
        recordedCost: { ...value.recordedCost, knownZeroCostInvocations: count },
      }),
    ).toBe(false)
  }
  expect(
    qualifiedCostEvidence({
      ...value,
      recordedCost: { ...value.recordedCost, amount: '1' },
    }),
  ).toBe(false)
  expect(
    qualifiedCostEvidence({
      ...value,
      recordedUsage: {
        ...value.recordedUsage,
        tokens: { ...value.recordedUsage.tokens, input: '1', total: '1' },
      },
    }),
  ).toBe(false)
  expect(
    qualifiedCostEvidence({
      ...value,
      costCoverage: { ...value.costCoverage!, visibility: 'hidden' },
    }),
  ).toBe(false)
})
