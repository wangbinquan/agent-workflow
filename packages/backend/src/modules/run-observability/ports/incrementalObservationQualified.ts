import type {
  CompleteObservationDimension,
  HistoricalObservationExecution,
  ObservationAttemptFacts,
} from '@agent-workflow/shared'
import type {
  CompleteObservationSection,
  CompleteObservationTask,
  ObservationTaskFacts,
} from '@agent-workflow/shared'
import type { CompleteObservationFold } from '../domain/completeObservationMetrics'
import type { IncrementalObservationContributionFold } from '../domain/incrementalObservationFold'
import { completeMetricsFold } from '../domain/completeMetricsFold'
import type { IncrementalObservationContribution } from './incrementalObservationProjection'

export interface QualifiedObservationDetail {
  readonly section: CompleteObservationSection | 'cohort-fold'
  readonly parent: string | null
  readonly key: string
  readonly taskId: string | null
  readonly cohortAt: number | null
  readonly document: unknown
  readonly selectors?: {
    readonly workflowId: string | null
    readonly repositories: readonly string[]
    readonly visibilityKey?: string
  }
  readonly bindings?: readonly { readonly kind: string; readonly identity: string }[]
  readonly visibility?: readonly {
    readonly taskId: string | null
    readonly ownerUserId: string | null
  }[]
  readonly timingAttempts?: readonly ObservationAttemptFacts[]
  readonly scopes?: readonly HistoricalObservationExecution[]
  /** Distinct physical candidate/model groups; an empty list proves no records. */
  readonly historicalRecordScopes?: readonly string[]
  readonly humanWaitingSince?: number | null
  readonly nativeRecord?: boolean
}
/** Stored once per physical candidate/model group, never once per reference. */
export interface HistoricalRecordScopeGroup {
  readonly scopes: readonly HistoricalObservationExecution[]
  readonly observed: boolean
  readonly model: { readonly provider: string; readonly id: string } | null
  /** Only unique-owner record values. Shared records cannot copy into owners. */
  readonly numeric: CompleteObservationFold
}
export interface QualifiedObservationHistoricalContribution {
  readonly key: string
  readonly ownerComponent: string
  readonly task: ObservationTaskFacts | null
  readonly cohortAt: number | null
  readonly assigned: boolean
  readonly fold: IncrementalObservationContributionFold
  readonly visibility: readonly {
    readonly taskId: string | null
    readonly ownerUserId: string | null
  }[]
  readonly scopes?: readonly HistoricalObservationExecution[]
  readonly historicalRecordScopes?: QualifiedObservationDetail['historicalRecordScopes']
}
export interface QualifiedObservationDimensionContribution {
  readonly identity: string
  readonly ownerComponent: string
  readonly task: ObservationTaskFacts | null
  readonly cohortAt: number | null
  readonly fold: CompleteObservationFold
  readonly dimension: Pick<CompleteObservationDimension, 'key' | 'kind' | 'label' | 'selection'>
}
export interface QualifiedObservationPrepared {
  readonly generation: string
  readonly snapshotId: string
  readonly asOf: number
  readonly rows: string
  readonly digest: string
  readonly baseRevision: string
  readonly preparationToken: string
}
export type QualifiedObservationContribution = IncrementalObservationContribution & {
  readonly detail: QualifiedObservationDetail
}
export function projectionTaskFold(
  task: CompleteObservationTask,
): IncrementalObservationContributionFold {
  return {
    ...completeMetricsFold(task.metrics),
    inventory: {
      tasks: '1',
      attempts: task.attemptCount,
      numericRecords: '0',
      nativeCaptures: '0',
    },
  }
}
