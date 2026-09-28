import type { PlatformObservation } from '../domain/platformObservation'
import type { PlatformObservationBinding, PlatformSyncState } from '../domain/platformSync'

export interface PlatformObservationTransaction {
  readonly state: PlatformSyncState
  get(generation: string, key: string): Promise<PlatformObservation | undefined>
  put(generation: string, item: PlatformObservation): Promise<void>
  discard(generation: string): Promise<void>
  save(state: PlatformSyncState): Promise<void>
}
export interface PlatformObservationStore {
  state(binding: PlatformObservationBinding): Promise<PlatformSyncState>
  change<T>(
    binding: PlatformObservationBinding,
    work: (tx: PlatformObservationTransaction) => Promise<T>,
  ): Promise<T>
  /** One consistent generation; suppress hidden and outdated valuations at the read boundary. */
  records(
    binding: PlatformObservationBinding,
    page: { readonly limit: number; readonly after?: string },
  ): Promise<{
    readonly state: PlatformSyncState
    readonly items: readonly PlatformObservation[]
    readonly nextCursor?: string
  }>
}
