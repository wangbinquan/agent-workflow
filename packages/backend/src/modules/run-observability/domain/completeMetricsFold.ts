import type { CompleteObservationMetrics } from '@agent-workflow/shared'
import { cnyPicos } from './cnyPricing'
import {
  emptyCompleteObservationFold,
  type CompleteObservationFold,
} from './completeObservationMetrics'

/** No lower bound is reconstructed from a non-ready public projection. */
export function completeMetricsFold(metrics: CompleteObservationMetrics): CompleteObservationFold {
  const fold = emptyCompleteObservationFold()
  if (metrics.state === 'not-ready') {
    fold.gaps = [...metrics.gaps]
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
  fold.visible = metrics.cost.state !== 'hidden'
  fold.priced = metrics.cost.state === 'complete'
  fold.picos = metrics.cost.amount === null ? '0' : String(cnyPicos(metrics.cost.amount))
  return fold
}
