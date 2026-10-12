import type { DatabaseTransaction } from '@/platform/persistence/databaseTransaction'
import type { IncrementalObservationWork } from './incrementalObservationProjection'

export interface OriginalObservationChange {
  readonly id: string
  readonly source: string
  readonly entityKey: string
  readonly operation: string
  readonly previousRoute: Readonly<Record<string, string | null>> | null
  readonly nextRoute: Readonly<Record<string, string | null>> | null
}
/** Routing is supplied by the original owners/platform. A null resolution is
 * retryable; an explicitly empty resolution proves the row has no contribution. */
export interface OriginalObservationChangeRouter {
  components(
    tx: DatabaseTransaction,
    change: OriginalObservationChange,
  ): Promise<readonly string[] | null>
}
export interface IncrementalObservationChangeQueue {
  dispatch(router: OriginalObservationChangeRouter, packetSize: number): Promise<number>
  bootstrap(): Promise<void>
  prepare(work: IncrementalObservationWork, signal: AbortSignal): Promise<void>
}
