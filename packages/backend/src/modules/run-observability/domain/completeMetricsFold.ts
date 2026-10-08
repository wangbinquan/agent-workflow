import type { CompleteObservationMetrics } from '@agent-workflow/shared'
import { cnyPicos } from './cnyPricing'
import {
  emptyCompleteObservationFold,
  type CompleteObservationFold,
} from './completeObservationMetrics'

/** Restore explicit received estimates separately from unknown Token records. */
export function completeMetricsFold(metrics: CompleteObservationMetrics): CompleteObservationFold {
  const fold = emptyCompleteObservationFold()
  if (metrics.state === 'not-ready') {
    fold.gaps = [...metrics.gaps]
    fold.tokenCoverageKnown = metrics.tokenCoverage !== undefined
    if (metrics.tokenCoverage) {
      fold.invocations = metrics.tokenCoverage.invocations
      fold.observedInvocations = metrics.tokenCoverage.observedInvocations
      if (metrics.tokenCoverage.historicalReferences !== undefined) {
        fold.historicalReferences = metrics.tokenCoverage.historicalReferences
        fold.observedHistoricalReferences =
          metrics.tokenCoverage.observedHistoricalReferences ?? '0'
      }
      fold.records = metrics.tokenCoverage.records
      fold.bucketRecords = { ...metrics.tokenCoverage.bucketRecords }
    }
    if (metrics.recordedUsage)
      for (const bucket of ['input', 'cacheRead', 'cacheWrite', 'output'] as const)
        fold.tokens[bucket] = metrics.recordedUsage.tokens[bucket] ?? '0'
    if (metrics.costCoverage) {
      fold.costRecords = metrics.costCoverage.records
      fold.pricedRecords = metrics.costCoverage.pricedRecords
      fold.partiallyPricedRecords = metrics.costCoverage.partiallyPricedRecords ?? '0'
      fold.visible = metrics.costCoverage.visibility !== 'hidden'
      fold.priced = false
    }
    if (metrics.recordedCost) fold.picos = String(cnyPicos(metrics.recordedCost.amount))
    return fold
  }
  if (metrics.state === 'not-applicable') return fold
  fold.tokens = {
    input: metrics.tokens.input,
    cacheRead: metrics.tokens.cacheRead,
    cacheWrite: metrics.tokens.cacheWrite,
    output: metrics.tokens.output,
  }
  fold.invocations = metrics.invocations
  fold.observedInvocations = metrics.observedInvocations
  if (metrics.historicalReferences !== undefined) {
    fold.historicalReferences = metrics.historicalReferences
    fold.observedHistoricalReferences = metrics.observedHistoricalReferences ?? '0'
  }
  fold.records = metrics.records
  fold.bucketRecords = {
    input: metrics.records,
    cacheRead: metrics.records,
    cacheWrite: metrics.records,
    output: metrics.records,
  }
  fold.costRecords = metrics.records
  fold.pricedRecords =
    metrics.cost.state === 'complete'
      ? metrics.records
      : (metrics.recordedCost?.pricedRecords ?? '0')
  fold.partiallyPricedRecords = metrics.recordedCost?.partiallyPricedRecords ?? '0'
  fold.visible = metrics.cost.state !== 'hidden'
  fold.priced = metrics.cost.state === 'complete'
  const amount = metrics.cost.amount ?? metrics.recordedCost?.amount
  fold.picos = amount === undefined ? '0' : String(cnyPicos(amount))
  return fold
}
