import type { AcceptedObservationInvocation } from '@agent-workflow/shared'
import type { PlatformObservation } from '../domain/platformObservation'
import type { PlatformSyncState } from '../domain/platformSync'
import type { UsageLedgerRecord } from '../domain/usageLedger'

type Page = {
  readonly invocation: AcceptedObservationInvocation
  /** A page can contain no matching records while still having a continuation. */
  readonly scanned: number
  readonly nextCursor?: string
}
export type InvocationObservationPage = Page &
  (
    | {
        readonly authority: 'local'
        readonly items: readonly UsageLedgerRecord[]
        /** Local pages may change between requests; they are not an aggregate snapshot. */
        readonly consistency: 'live-page'
      }
    | {
        readonly authority: 'crewstation'
        readonly items: readonly PlatformObservation[]
        readonly consistency: 'platform-revision'
        readonly source: 'bound' | 'legacy-unbound'
        readonly state: PlatformSyncState | null
      }
  )

/** Internal read port. HTTP callers must first use the task owner's visibility query. */
export interface InvocationObservationQuery {
  read(input: {
    readonly invocationId: string
    readonly limit: number
    readonly after?: string
  }): Promise<InvocationObservationPage>
}
