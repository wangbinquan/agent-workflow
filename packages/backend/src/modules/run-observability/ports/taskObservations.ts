import type {
  AcceptedObservationInvocation,
  ObservationAttemptFacts,
  ObservationTaskFacts,
  ObservationTaskPageQuery,
  ObservationTokenUsage,
  ObservationSourceBacklog,
} from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import type { PlatformObservationStore } from './platformObservationStore'
import type { UsageLedgerStore } from './usageLedger'

/** Structurally supplied by the TaskExecution owner, only at bootstrap. */
export interface ObservationTaskSource {
  list(input: { readonly actor: Actor; readonly query: ObservationTaskPageQuery }): Promise<{
    readonly items: readonly ObservationTaskFacts[]
    readonly nextCursor: string | null
  }>
  get(actor: Actor, taskId: string): Promise<ObservationTaskFacts | null>
  sourceBacklog(taskIds: readonly string[]): Promise<readonly ObservationSourceBacklog[]>
  attempts(
    taskId: string,
    limit: number,
  ): Promise<{
    readonly items: readonly ObservationAttemptFacts[]
    readonly truncated: boolean
  }>
}
export interface ObservationSnapshotSources {
  readonly tasks: ObservationTaskSource
  invocations(taskId: string): Promise<{
    readonly items: readonly AcceptedObservationInvocation[]
    readonly truncated: boolean
  }>
  readonly local: Pick<UsageLedgerStore, 'records' | 'captures'>
  readonly platform: Pick<PlatformObservationStore, 'records'>
  value(input: {
    readonly invocationId: string
    readonly model: { readonly provider: string | null; readonly id: string } | null
    readonly condition: string | null
    readonly usage: ObservationTokenUsage
  }): Promise<{
    readonly currency: 'CNY'
    readonly availability: string
    readonly amountDecimal: string | null
    readonly priceVersionId: string | null
    readonly completeness?: 'complete' | 'partial' | 'unpriced'
  }>
}
export interface ObservationSnapshot {
  read<T>(work: (sources: ObservationSnapshotSources) => Promise<T>): Promise<T>
}
