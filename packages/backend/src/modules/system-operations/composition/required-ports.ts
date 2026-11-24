// RFC-395 II-b O3 — Doctor keeps the exact native read handles it opens today.
import type { NativeDatabaseReadSource } from '@/platform/persistence/nativeReadSource'

export type DoctorDatabaseSource = NativeDatabaseReadSource

export interface DoctorTaskLifecyclePort {
  countLifecycleStates(source: DoctorDatabaseSource): Promise<{
    readonly interrupted: number
    readonly failed: number
    readonly awaitingReview: number
    readonly awaitingHuman: number
    readonly quarantined: number
  }>
}

// RFC-562: each owner normalizes only its own rows after a hosted restore; task-execution implements this through
// its system-operations adapter.
export type { HostedRestoreNormalizationParticipant } from '../application/ports/hostedRestoreNormalization'
