import type { PlatformObservationPage } from '../domain/platformObservation'

export type PlatformObservationRequest = {
  readonly projectId: string
  readonly taskId: string
  readonly limit: number
  readonly signal?: AbortSignal
  readonly expectedSchemaVersion?: 1 | 2
} & (
  | { readonly mode: 'incremental'; readonly after?: string }
  | { readonly mode: 'snapshot'; readonly snapshotId?: string; readonly cursor?: string }
)
export interface PlatformObservationSource {
  /** Canonical usage and authorized CNY values only; no local accounting fallback. */
  read(input: PlatformObservationRequest): Promise<PlatformObservationPage>
}
