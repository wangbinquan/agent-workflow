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
  readonly timingAttempts?: readonly import('@agent-workflow/shared').ObservationAttemptFacts[]
  readonly scopes?: readonly import('@agent-workflow/shared').HistoricalObservationExecution[]
  readonly nativeRecord?: boolean
}
export interface QualifiedObservationHistoricalContribution {
  readonly key: string
  readonly ownerComponent: string
  readonly task: ObservationTaskFacts | null
  readonly cohortAt: number | null
  readonly assigned: boolean
  readonly fold: CompleteObservationFold
  readonly visibility: readonly {
    readonly taskId: string | null
    readonly ownerUserId: string | null
  }[]
  readonly scopes?: readonly import('@agent-workflow/shared').HistoricalObservationExecution[]
}
export interface QualifiedObservationDimensionContribution {
  readonly identity: string
  readonly ownerComponent: string
  readonly task: ObservationTaskFacts | null
  readonly cohortAt: number | null
  readonly fold: CompleteObservationFold
  readonly dimension: Pick<
    import('@agent-workflow/shared').CompleteObservationDimension,
    'key' | 'kind' | 'label' | 'selection'
  >
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
