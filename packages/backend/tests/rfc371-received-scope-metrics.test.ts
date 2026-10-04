// RFC-371 received-scope-tokens: missing and ambiguous evidence must retain original populations.
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
import {
  qualifiedCostEvidence,
  completeReportFactRow,
} from '@/modules/run-observability/domain/completeReportFacts'

const priced = { amount: '0.05', complete: true, hidden: false }
const bins = { input: '123', cacheRead: '40', cacheWrite: '0', output: '6' }

test('Task/Agent/runtime round trips retain received buckets and the original one of two calls', () => {
  const known = emptyCompleteObservationFold('1')
  known.observedInvocations = '1'
  addCompleteObservationAllocation(known, bins, priced)
  const missing = emptyCompleteObservationFold('1')
  completeObservationGap(missing, 'usage-unobserved')
  const absent = completeObservationMetrics(missing)
  expect(absent).toEqual({
    state: 'not-ready',
    gaps: ['usage-unobserved'],
    tokenCoverage: {
      invocations: '1',
      observedInvocations: '0',
      records: '0',
      bucketRecords: { input: '0', cacheRead: '0', cacheWrite: '0', output: '0' },
    },
  })
  const parent = emptyCompleteObservationFold()
  mergeCompleteObservationFold(parent, completeMetricsFold(completeObservationMetrics(known)))
  mergeCompleteObservationFold(parent, completeMetricsFold(absent))
  const value = completeObservationMetrics(parent)
  expect(value).toEqual({
    state: 'not-ready',
    gaps: ['usage-unobserved'],
    tokenCoverage: {
      invocations: '2',
      observedInvocations: '1',
      records: '1',
      bucketRecords: { input: '1', cacheRead: '1', cacheWrite: '1', output: '1' },
    },
    recordedUsage: {
      invocations: '2',
      observedInvocations: '1',
      records: '1',
      bucketRecords: { input: '1', cacheRead: '1', cacheWrite: '1', output: '1' },
      tokens: { ...bins, total: '169' },
    },
    costCoverage: { records: '1', pricedRecords: '1', visibility: 'visible' },
    recordedCost: { currency: 'CNY', amount: '0.05', records: '1', pricedRecords: '1' },
  })
  for (let depth = 0; depth < 4; depth++) {
    const next = completeObservationMetrics(completeMetricsFold(value))
    expect(next).toEqual(value)
    expect(qualifiedCostEvidence(next)).toBe(true)
  }
  expect(value).not.toHaveProperty('tokens')
  expect(value).not.toHaveProperty('cost')
})

test('nullable buckets, real zero and integers beyond Number precision survive the same fold', () => {
  const fold = emptyCompleteObservationFold('1')
  fold.observedInvocations = '1'
  addCompleteObservationAllocation(
    fold,
    { input: '9007199254740993', cacheRead: null, cacheWrite: '0', output: '7' },
    { amount: null, complete: false, hidden: false },
  )
  const value = completeObservationMetrics(fold)
  if (value.state !== 'not-ready') throw new Error('Missing bucket became a complete total')
  expect(value.recordedUsage).toEqual({
    invocations: '1',
    observedInvocations: '1',
    records: '1',
    bucketRecords: { input: '1', cacheRead: '0', cacheWrite: '1', output: '1' },
    tokens: {
      input: '9007199254740993',
      cacheRead: null,
      cacheWrite: '0',
      output: '7',
      total: '9007199254741000',
    },
  })
  expect(value.costCoverage).toEqual({ records: '1', pricedRecords: '0', visibility: 'visible' })
  expect(value).not.toHaveProperty('recordedCost')
  expect(completeObservationMetrics(completeMetricsFold(value))).toEqual(value)
  expect(qualifiedCostEvidence(value)).toBe(true)
})

test('all-null and all-ambiguous records retain their denominator without invented Token or CNY', () => {
  for (const qualified of [true, false]) {
    const fold = emptyCompleteObservationFold('1')
    fold.observedInvocations = '1'
    addCompleteObservationAllocation(
      fold,
      { input: null, cacheRead: null, cacheWrite: null, output: null },
      { amount: null, complete: false, hidden: false },
      qualified,
    )
    const value = completeObservationMetrics(fold)
    if (value.state !== 'not-ready') throw new Error('Unknown record became a complete total')
    expect(value.tokenCoverage).toEqual({
      invocations: '1',
      observedInvocations: '1',
      records: '1',
      bucketRecords: { input: '0', cacheRead: '0', cacheWrite: '0', output: '0' },
    })
    expect(value).not.toHaveProperty('recordedUsage')
    expect(value).not.toHaveProperty('recordedCost')
    expect(completeObservationMetrics(completeMetricsFold(value))).toEqual(value)
    expect(qualifiedCostEvidence(value)).toBe(true)
  }
})

test('an excluded ambiguous record is counted once and cannot add its original known values or quote', () => {
  const fold = emptyCompleteObservationFold('1')
  fold.observedInvocations = '1'
  addCompleteObservationAllocation(fold, bins, priced)
  addCompleteObservationAllocation(
    fold,
    { input: '999', cacheRead: '999', cacheWrite: '999', output: '999' },
    { amount: '999', complete: true, hidden: false },
    false,
  )
  const value = completeObservationMetrics(fold)
  if (value.state !== 'not-ready') throw new Error('Ambiguous scope became complete')
  expect(value.tokenCoverage?.records).toBe('2')
  expect(value.recordedUsage?.tokens).toEqual({ ...bins, total: '169' })
  expect(value.recordedUsage?.bucketRecords).toEqual({
    input: '1',
    cacheRead: '1',
    cacheWrite: '1',
    output: '1',
  })
  expect(value.recordedCost).toEqual({
    currency: 'CNY',
    amount: '0.05',
    records: '2',
    pricedRecords: '1',
  })
  expect(qualifiedCostEvidence(value)).toBe(true)
})

test('legacy incomplete metrics remain immutable without inventing a new Token population', () => {
  const legacy: CompleteObservationMetrics = {
    state: 'not-ready',
    gaps: ['usage-unobserved'],
    costCoverage: { records: '2', pricedRecords: '1', visibility: 'visible' },
    recordedCost: { currency: 'CNY', amount: '0.05', records: '2', pricedRecords: '1' },
  }
  expect(completeObservationMetrics(completeMetricsFold(legacy))).toEqual(legacy)
  expect(qualifiedCostEvidence(legacy)).toBe(true)
  const received = completeMetricsFold(legacy)
  addCompleteObservationAllocation(received, bins, priced)
  const result = completeObservationMetrics(received)
  expect(result).not.toHaveProperty('tokenCoverage')
  expect(result).not.toHaveProperty('recordedUsage')
})

test('qualification rejects corrupted nullable values, bucket counts, populations and received sums', () => {
  const fold = emptyCompleteObservationFold('1')
  fold.observedInvocations = '1'
  addCompleteObservationAllocation(fold, { ...bins, cacheRead: null }, priced)
  const value = completeObservationMetrics(fold)
  if (value.state !== 'not-ready' || !value.recordedUsage || !value.tokenCoverage)
    throw new Error('Original received evidence missing')
  const usage = value.recordedUsage,
    coverage = value.tokenCoverage
  for (const altered of [
    { ...value, recordedUsage: { ...usage, tokens: { ...usage.tokens, cacheRead: '0' } } },
    { ...value, recordedUsage: { ...usage, tokens: { ...usage.tokens, total: '1' } } },
    { ...value, recordedUsage: { ...usage, records: '2' } },
    {
      ...value,
      recordedUsage: { ...usage, bucketRecords: { ...usage.bucketRecords, input: '2' } },
    },
    { ...value, tokenCoverage: { ...coverage, observedInvocations: '2' } },
    { ...value, tokenCoverage: { ...coverage, records: '01' } },
    {
      ...value,
      tokenCoverage: { ...coverage, bucketRecords: { ...coverage.bucketRecords, input: '2' } },
    },
    { ...value, tokenCoverage: undefined },
    { ...value, recordedUsage: undefined },
  ]) {
    expect(qualifiedCostEvidence(altered)).toBe(false)
    expect(() =>
      completeReportFactRow(
        { section: 'tasks', parent: null, key: 'original', document: { metrics: altered } },
        fold.gaps,
      ),
    ).toThrow('Original scope metrics are not qualified')
  }
})
