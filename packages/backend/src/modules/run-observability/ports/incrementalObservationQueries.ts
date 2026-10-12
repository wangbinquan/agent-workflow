import type { Actor } from '@/auth/actor'
import type { ObservationOverviewQuery, ObservationTaskFacts } from '@agent-workflow/shared'
import type { IncrementalObservationVersion } from './incrementalObservationProjection'
import type { QualifiedObservationContribution } from './incrementalObservationQualified'

export interface ObservationProjectionView {
  readonly id: string
  readonly actorScope: string
  readonly generation: string
  readonly version: IncrementalObservationVersion
  readonly query: ObservationOverviewQuery
  readonly taskId?: string
}
export interface IncrementalObservationQuerySource {
  snapshot(revision?: string): Promise<IncrementalObservationVersion | null>
  aggregate(
    key: string,
    version: IncrementalObservationVersion,
  ): Promise<import('../domain/incrementalObservationFold').IncrementalObservationFold | null>
  aggregates(
    keys: readonly string[],
    version: IncrementalObservationVersion,
  ): Promise<
    ReadonlyMap<string, import('../domain/incrementalObservationFold').IncrementalObservationFold>
  >
  bootstrapComplete(version: IncrementalObservationVersion): Promise<boolean>
  days(input: {
    readonly version: IncrementalObservationVersion
    readonly taskIds: readonly string[]
    readonly components: readonly string[]
    readonly from: number
    readonly to: number
  }): AsyncIterable<import('../domain/incrementalObservationFold').IncrementalObservationFold>
  identities(input: {
    readonly version: IncrementalObservationVersion
    readonly taskIds?: readonly string[]
    readonly components?: readonly string[]
  }): AsyncIterable<{
    readonly section: string
    readonly key: string
    readonly component: string
    readonly detail: QualifiedObservationContribution['detail']
  }>
  counts(input: {
    readonly version: IncrementalObservationVersion
    readonly taskIds?: readonly string[]
    readonly standaloneComponents?: readonly string[]
    readonly from?: number
    readonly to?: number
  }): Promise<readonly { readonly section: string; readonly total: string }[]>
  details(input: {
    readonly version: IncrementalObservationVersion
    readonly section: string
    readonly parent?: string | null
    readonly taskIds?: readonly string[]
    readonly components?: readonly string[]
    readonly standalone?: boolean
    readonly from?: number
    readonly to?: number
  }): AsyncIterable<QualifiedObservationContribution>
  visibleTasks(
    actor: Actor,
    query: ObservationOverviewQuery,
    taskId?: string,
  ): AsyncIterable<ObservationTaskFacts>
  visibleTaskIds(actor: Actor, ids: readonly string[]): Promise<readonly string[]>
  retainView(input: Omit<ObservationProjectionView, 'id'>): Promise<ObservationProjectionView>
  activateView(
    id: string,
    actorScope: string,
    version: IncrementalObservationVersion,
  ): Promise<ObservationProjectionView>
  view(id: string, actorScope: string): Promise<ObservationProjectionView>
}
