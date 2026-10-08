import type {
  AcceptedObservationInvocation,
  ObservationAttemptFacts,
  ObservationTaskFacts,
  ObservationTaskPageQuery,
  ObservationTokenUsage,
  ObservationSpanSourceInput,
  ObservationSpanSourcePage,
  ObservationSourceBacklog,
} from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import type { PlatformObservationStore } from './platformObservationStore'
import type { UsageLedgerStore } from './usageLedger'
import type { ObservationNativeScopeSource } from '../public/participants'

/** Structurally supplied by the TaskExecution owner, only at bootstrap. */
export interface ObservationTaskSource {
  readonly nativeScopes?: ObservationNativeScopeSource
  spanSources?(input: ObservationSpanSourceInput): Promise<ObservationSpanSourcePage>
  list(input: { readonly actor: Actor; readonly query: ObservationTaskPageQuery }): Promise<{
    readonly items: readonly ObservationTaskFacts[]
    readonly positions: readonly { readonly taskId: string; readonly cursor: string }[]
    readonly nextCursor: string | null
  }>
  get(actor: Actor, taskId: string): Promise<ObservationTaskFacts | null>
  sourceBacklog(taskIds: readonly string[]): Promise<readonly ObservationSourceBacklog[]>
  /** Original owner keyset pages; consume every continuation to null in the same snapshot. */
  attemptPage?(
    taskId: string,
    page: { readonly limit: number; readonly after?: string },
  ): Promise<{
    readonly items: readonly ObservationAttemptFacts[]
    readonly nextCursor: string | null
  }>
  attempts(
    taskId: string,
    limit: number,
  ): Promise<{
    readonly items: readonly ObservationAttemptFacts[]
    readonly truncated: boolean
  }>
}
/** Full reports retain both original Task and System groups without inventing Task rows. */
export interface CompleteObservationTaskSource extends ObservationTaskSource {
  visibleIds(actor: Actor, sourceIds: readonly string[]): Promise<readonly string[]>
  originalAgentName?(id: string): Promise<string | null>
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
