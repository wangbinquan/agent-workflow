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
    if (metrics.costCoverage) {
      fold.costRecords = metrics.costCoverage.records
      fold.pricedRecords = metrics.costCoverage.pricedRecords
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
  fold.records = metrics.records
  fold.costRecords = metrics.records
  fold.pricedRecords =
    metrics.cost.state === 'complete'
      ? metrics.records
      : (metrics.recordedCost?.pricedRecords ?? '0')
  fold.visible = metrics.cost.state !== 'hidden'
  fold.priced = metrics.cost.state === 'complete'
  const amount = metrics.cost.amount ?? metrics.recordedCost?.amount
  fold.picos = amount === undefined ? '0' : String(cnyPicos(amount))
  return fold
}
