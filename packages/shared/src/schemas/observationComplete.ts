import type { ObservationTaskFacts, ObservationAttemptFacts } from './observationTasks'
import type { ObservationTokenUsage } from './observationUsage'
import type { AcceptedObservationInvocation } from './observationInvocation'

/** Decimal strings preserve exact cardinalities and every original token bucket. */
export type CompleteObservationMetrics =
  | { readonly state: 'not-ready'; readonly gaps: readonly string[] }
  | { readonly state: 'not-applicable' }
  | {
      readonly state: 'ready'
      readonly invocations: string
      readonly observedInvocations: string
      readonly records: string
      readonly tokens: Readonly<Record<keyof ObservationTokenUsage, string>> & {
        readonly total: string
      }
      readonly cost: {
        readonly currency: 'CNY'
        readonly state: 'complete' | 'unpriced' | 'hidden'
        readonly amount: string | null
      }
    }
export interface CompleteObservationAllocation {
  readonly invocation: AcceptedObservationInvocation
  readonly recordId: string
  readonly sourceId: string
  readonly model: { readonly provider: string | null; readonly id: string } | null
  readonly observedAt: number
  readonly contribution: ObservationTokenUsage
  readonly cost: {
    readonly amount: string | null
    readonly complete: boolean
    readonly hidden: boolean
  }
}
export interface CompleteObservationAttempt extends ObservationAttemptFacts {
  readonly metrics: CompleteObservationMetrics
  readonly durationMs: string | null
  readonly open: boolean
}
export interface CompleteObservationTiming {
  readonly wallMs: string | null
  readonly runningMs: string | null
  readonly range: { readonly from: number; readonly to: number } | null
  readonly intervals:
    | {
        readonly state: 'complete'
        readonly cumulativeMs: string
        readonly activeUnionMs: string
        readonly unknown: '0'
      }
    | { readonly state: 'not-ready'; readonly unknown: string }
}
export interface CompleteObservationTask {
  readonly task: ObservationTaskFacts
  readonly metrics: CompleteObservationMetrics
  readonly attemptCount: string
  readonly timing: CompleteObservationTiming
}
