import type { IncrementalObservationFold } from '../domain/incrementalObservationFold'
import type { Actor } from '@/auth/actor'
import type { ObservationOverviewQuery } from '@agent-workflow/shared'
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
  ): Promise<IncrementalObservationFold | null>
  aggregates(
    keys: readonly string[],
    version: IncrementalObservationVersion,
  ): Promise<ReadonlyMap<string, IncrementalObservationFold>>
  bootstrapComplete(version: IncrementalObservationVersion): Promise<boolean>
  days(input: {
    readonly version: IncrementalObservationVersion
    readonly taskIds: readonly string[]
    readonly components: readonly string[]
    readonly from: number
    readonly to: number
  }): AsyncIterable<IncrementalObservationFold>
  /** Hour buckets for complete interiors; exact boundary rows retain their actual clocks. */
  windowCells?(input: {
    readonly version: IncrementalObservationVersion
    readonly taskIds: readonly string[]
    readonly components: readonly string[]
    readonly from: number
    readonly to: number
    readonly timezone: string
  }): AsyncIterable<QualifiedObservationContribution>
  groupedDetails?(input: {
    version: IncrementalObservationVersion
    section: string
    taskIds?: readonly string[]
    parent?: string | null
  }): AsyncIterable<QualifiedObservationContribution>
  metadataChanges?(
    from: string,
    version: IncrementalObservationVersion,
  ): AsyncIterable<{ key: string; row: QualifiedObservationContribution | null }>
  retainScope?(
    id: string,
    taskIds: readonly string[],
    components: readonly string[],
    viewId?: string,
  ): Promise<void>
  indexedDetails?(version: IncrementalObservationVersion): Promise<boolean>
  countGroups?(
    scope: string,
    version: IncrementalObservationVersion,
  ): AsyncIterable<{
    detail: QualifiedObservationContribution['detail']
    component: string
    total: string
  }>
  detailPacket?(input: {
    version: IncrementalObservationVersion
    scope: string
    section: string
    parent: string | null
    after?: string
    limit: number
  }): Promise<{ rows: readonly QualifiedObservationContribution[]; next: string | null }>
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
    readonly includeUnassigned?: boolean
  }): AsyncIterable<QualifiedObservationContribution>
  visibleTaskIds(actor: Actor, ids: readonly string[]): Promise<readonly string[]>
  retainView(input: Omit<ObservationProjectionView, 'id'>): Promise<ObservationProjectionView>
  activateView(
    id: string,
    actorScope: string,
    version: IncrementalObservationVersion,
  ): Promise<ObservationProjectionView>
  view(id: string, actorScope: string): Promise<ObservationProjectionView>
}
