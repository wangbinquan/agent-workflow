import type { Actor } from '@/auth/actor'
import type {
  AcceptedObservationInvocation,
  ObservationAttemptFacts,
  ObservationTaskFacts,
  ObservationTaskPageQuery,
  ObservationSourceBacklog,
  ObservationSpanSourcePage,
} from '@agent-workflow/shared'
import type { UsageLedgerRecord } from '../domain/usageLedger'
import type { PlatformObservation } from '../domain/platformObservation'
import type { PlatformObservationBinding, PlatformSyncState } from '../domain/platformSync'
import type { UsageCaptureReceipt } from './usageLedger'
import type { CompleteSourceReader } from './completeReport'
import type { ObservationNativeScopeSource } from '../public/participants'

/** All readers are bound to one original snapshot. No method takes a total-record budget. */
export interface CompleteObservationSources {
  readonly nativeScopes?: ObservationNativeScopeSource
  readonly snapshotId: string
  tasks(
    actor: Actor,
    query: Omit<ObservationTaskPageQuery, 'after' | 'limit'>,
  ): CompleteSourceReader<ObservationTaskFacts>
  attempts(taskId: string): CompleteSourceReader<ObservationAttemptFacts>
  invocations(taskId: string): CompleteSourceReader<AcceptedObservationInvocation>
  /** Read a Task's records once; the private workspace joins original invocation identities. */
  usage(taskId: string): CompleteSourceReader<UsageLedgerRecord>
  captures(taskId: string): CompleteSourceReader<UsageCaptureReceipt>
  platform(binding: PlatformObservationBinding): CompleteSourceReader<PlatformObservation>
  platformState(binding: PlatformObservationBinding): Promise<PlatformSyncState>
  backlog(taskId: string): Promise<ObservationSourceBacklog>
  spans?(
    taskId: string,
  ): CompleteSourceReader<Omit<ObservationSpanSourcePage, 'nextCursor' | 'truncated'>>
}
