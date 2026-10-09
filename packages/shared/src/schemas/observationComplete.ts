import type { ObservationTaskFacts, ObservationAttemptFacts } from './observationTasks'
import type { ObservationTokenUsage } from './observationUsage'
import type { AcceptedObservationInvocation } from './observationInvocation'

interface RecordedObservationCost {
  readonly currency: 'CNY'
  readonly amount: string
  readonly records: string
  readonly pricedRecords: string
  readonly partiallyPricedRecords?: string
}
/** Decimal strings preserve exact cardinalities and every original token bucket. */
export type CompleteObservationMetrics =
  | {
      readonly state: 'not-ready'
      readonly gaps: readonly string[]
      readonly tokenCoverage?: {
        readonly historicalReferences?: string
        readonly observedHistoricalReferences?: string
        readonly invocations: string
        readonly observedInvocations: string
        readonly records: string
        readonly bucketRecords: {
          readonly input: string
          readonly cacheRead: string
          readonly cacheWrite: string
          readonly output: string
        }
      }
      readonly recordedUsage?: {
        readonly historicalReferences?: string
        readonly observedHistoricalReferences?: string
        readonly invocations: string
        readonly observedInvocations: string
        readonly records: string
        readonly bucketRecords: {
          readonly input: string
          readonly cacheRead: string
          readonly cacheWrite: string
          readonly output: string
        }
        readonly tokens: {
          readonly input: string | null
          readonly cacheRead: string | null
          readonly cacheWrite: string | null
          readonly output: string | null
          readonly total: string
        }
      }
      readonly costCoverage?: {
        readonly records: string
        readonly pricedRecords: string
        readonly partiallyPricedRecords?: string
        readonly visibility: 'visible' | 'hidden'
      }
      readonly recordedCost?: RecordedObservationCost
    }
  | { readonly state: 'not-applicable' }
  | {
      readonly state: 'ready'
      readonly historicalReferences?: string
      readonly observedHistoricalReferences?: string
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
      readonly recordedCost?: RecordedObservationCost
    }
export interface CompleteObservationOccurrence {
  readonly occurredAt: number | null
  readonly basis: 'native-step' | 'request' | null
  readonly reason?:
    | 'time-unobserved'
    | 'time-conflicting'
    | 'time-nondiscrete'
    | 'time-evidence-missing'
}
export interface CompleteObservationAllocation {
  readonly invocation: AcceptedObservationInvocation
  readonly recordId: string
  readonly sourceId: string
  readonly model: { readonly provider: string | null; readonly id: string } | null
  readonly observedAt: number
  /** Optional only in usage-window reports; never inferred from observedAt. */
  readonly occurrence?: CompleteObservationOccurrence
  readonly contribution: ObservationTokenUsage
  /** Ambiguous original contributions retain their population, never guessed values. */
  readonly qualified?: boolean
  readonly cost: {
    readonly amount: string | null
    readonly complete: boolean
    readonly hidden: boolean
  }
}
export interface CompleteObservationTimePartition {
  readonly identity: string
  readonly partition: 'in-window' | 'outside-window' | 'unassigned-time'
  readonly kind: 'accepted' | 'historical' | 'quality'
  readonly recordId: string
  readonly sourceId: string
  readonly task: ObservationTaskFacts | null
  readonly invocation: AcceptedObservationInvocation | null
  readonly occurrence: CompleteObservationOccurrence
  readonly metrics: CompleteObservationMetrics
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

interface CompleteObservationTraceIdentity {
  readonly taskId: string
  readonly nodeRunId: string
}
export type CompleteObservationTraceStatus = CompleteObservationTraceIdentity &
  (
    | {
        readonly state: 'not-ready'
        readonly reasons: readonly string[]
        /** Boundaries of retained original facts, not a complete duration or count. */
        readonly knownRange: { readonly from: number; readonly to: number } | null
      }
    | { readonly state: 'not-applicable' }
    | {
        readonly state: 'complete'
        readonly spanCount: string
        readonly captureCount: string
        readonly priorRepairCount: string
        readonly range: { readonly from: number; readonly to: number } | null
      }
  )
