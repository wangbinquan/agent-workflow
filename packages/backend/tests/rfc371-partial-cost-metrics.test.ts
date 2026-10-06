// RFC-371: known CNY from partial valuation survives every original scope without claiming a full bill.
import { expect, test } from 'bun:test'
import {
  addCompleteObservationAllocation,
  completeObservationMetrics,
  emptyCompleteObservationFold,
  mergeCompleteObservationFold,
} from '@/modules/run-observability/domain/completeObservationMetrics'
import { completeMetricsFold } from '@/modules/run-observability/domain/completeMetricsFold'
import { qualifiedCostEvidence } from '@/modules/run-observability/domain/completeReportFacts'

const partialUsage = { input: '120', cacheRead: null, cacheWrite: '0', output: null }
test('known nullable buckets retain actual partial CNY and its separate original record count', () => {
  const fold = emptyCompleteObservationFold('1')
  fold.observedInvocations = '1'
  addCompleteObservationAllocation(fold, partialUsage, {
    amount: '0.00012',
    complete: false,
    hidden: false,
  })
  const value = completeObservationMetrics(fold)
  expect(value).toMatchObject({
    state: 'not-ready',
    recordedUsage: {
      tokens: { ...partialUsage, total: '120' },
      bucketRecords: { input: '1', cacheRead: '0', cacheWrite: '1', output: '0' },
    },
    costCoverage: {
      records: '1',
      pricedRecords: '0',
      partiallyPricedRecords: '1',
      visibility: 'visible',
    },
    recordedCost: {
      currency: 'CNY',
      amount: '0.00012',
      records: '1',
      pricedRecords: '0',
      partiallyPricedRecords: '1',
    },
  })
  expect(value).not.toHaveProperty('cost')
  expect(value).not.toHaveProperty('tokens')
  expect(qualifiedCostEvidence(value)).toBe(true)
  expect(completeObservationMetrics(completeMetricsFold(value))).toEqual(value)
})
test('restoration and mixed scope merging charge full and partial amounts once and retain unpriced population', () => {
  const partial = emptyCompleteObservationFold('1'),
    full = emptyCompleteObservationFold('1'),
    unknown = emptyCompleteObservationFold('1')
  addCompleteObservationAllocation(partial, partialUsage, {
    amount: '0.00012',
    complete: false,
    hidden: false,
  })
  addCompleteObservationAllocation(
    full,
    { input: '1', cacheRead: '2', cacheWrite: '0', output: '3' },
    { amount: '0.02', complete: true, hidden: false },
  )
  addCompleteObservationAllocation(
    unknown,
    { input: null, cacheRead: null, cacheWrite: null, output: null },
    { amount: null, complete: false, hidden: false },
  )
  const merged = emptyCompleteObservationFold()
  for (const source of [partial, full, unknown])
    mergeCompleteObservationFold(merged, completeMetricsFold(completeObservationMetrics(source)))
  const value = completeObservationMetrics(merged)
  expect(value).toMatchObject({
    state: 'not-ready',
    recordedUsage: {
      records: '3',
      tokens: { input: '121', cacheRead: '2', cacheWrite: '0', output: '3', total: '126' },
    },
    costCoverage: { records: '3', pricedRecords: '1', partiallyPricedRecords: '1' },
    recordedCost: {
      amount: '0.02012',
      records: '3',
      pricedRecords: '1',
      partiallyPricedRecords: '1',
    },
  })
  expect(qualifiedCostEvidence(value)).toBe(true)
  expect(completeObservationMetrics(completeMetricsFold(value))).toEqual(value)
})
test('actual partial zero remains visible while unknown, ambiguous and hidden amounts remain unqualified', () => {
  const zero = emptyCompleteObservationFold('1')
  addCompleteObservationAllocation(
    zero,
    { ...partialUsage, input: '0' },
    { amount: '0', complete: false, hidden: false },
  )
  const value = completeObservationMetrics(zero)
  expect(value).toMatchObject({
    recordedCost: { amount: '0', pricedRecords: '0', partiallyPricedRecords: '1' },
  })
  expect(qualifiedCostEvidence(value)).toBe(true)
  for (const [usage, hidden, qualified] of [
    [{ input: null, cacheRead: null, cacheWrite: null, output: null }, false, true],
    [partialUsage, true, true],
    [partialUsage, false, false],
  ] as const) {
    const fold = emptyCompleteObservationFold('1')
    addCompleteObservationAllocation(
      fold,
      usage,
      { amount: '0.9', complete: false, hidden },
      qualified,
    )
    expect(completeObservationMetrics(fold)).not.toHaveProperty('recordedCost')
  }
})
test('partial populations never relax original full-price bucket qualification or immutable format', () => {
  const fold = emptyCompleteObservationFold('1')
  addCompleteObservationAllocation(fold, partialUsage, {
    amount: '0.00012',
    complete: false,
    hidden: false,
  })
  const value = completeObservationMetrics(fold)
  if (
    value.state !== 'not-ready' ||
    !value.costCoverage ||
    !value.recordedCost ||
    !value.tokenCoverage
  )
    throw new Error('Actual partial evidence missing')
  for (const bad of [
    { ...value, costCoverage: { ...value.costCoverage, partiallyPricedRecords: '2' } },
    { ...value, recordedCost: { ...value.recordedCost, partiallyPricedRecords: '2' } },
    {
      ...value,
      costCoverage: {
        ...value.costCoverage,
        pricedRecords: '1',
        partiallyPricedRecords: undefined,
      },
      recordedCost: {
        ...value.recordedCost,
        pricedRecords: '1',
        partiallyPricedRecords: undefined,
      },
    },
    { ...value, costCoverage: { ...value.costCoverage, partiallyPricedRecords: '01' } },
    { ...value, costCoverage: { ...value.costCoverage, visibility: 'hidden' as const } },
    { ...value, tokenCoverage: undefined, recordedUsage: undefined },
  ])
    expect(qualifiedCostEvidence(bad)).toBe(false)
  const legacy = emptyCompleteObservationFold('1')
  addCompleteObservationAllocation(
    legacy,
    { input: '1', cacheRead: '2', cacheWrite: '0', output: '3' },
    { amount: '0.02', complete: true, hidden: false },
  )
  const old = completeObservationMetrics(legacy)
  expect(JSON.stringify(old)).not.toContain('partiallyPricedRecords')
  expect(completeObservationMetrics(completeMetricsFold(old))).toEqual(old)
})
