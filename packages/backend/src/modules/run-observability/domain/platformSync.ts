import type { PlatformObservation, PlatformObservationPage } from './platformObservation'

/** sourceId is the immutable platform installation/source identity supplied by bootstrap. */
export interface PlatformObservationBinding {
  readonly sourceId: string
  readonly projectId: string
  readonly taskId: string
}
export interface PlatformSyncState {
  readonly binding: PlatformObservationBinding
  readonly revision: number
  readonly cursor: string | null
  readonly generation: string | null
  /** Missing in stored pre-v2 states; readers normalize it to 1. */
  readonly schemaVersion: 1 | 2
  readonly mode: 'snapshot' | 'incremental'
  readonly staging: {
    readonly generation: string
    readonly snapshotId: string
    readonly cursor: string
    readonly through: string
    readonly expiresAt: string
    readonly asOf: string
    readonly schemaVersion: 1 | 2
  } | null
  readonly visibilityRevision: number | null
  readonly costVisibility: PlatformObservationPage['costVisibility']
  readonly costsReady: boolean
  readonly status: 'initial' | 'syncing' | 'ready' | 'failed'
  readonly error: string | null
  readonly checkedAt: number | null
  readonly asOf: string | null
  readonly gaps: PlatformObservationPage['gaps']
}

export function initialPlatformSyncState(binding: PlatformObservationBinding): PlatformSyncState {
  return {
    binding: { ...binding },
    revision: 0,
    cursor: null,
    generation: null,
    schemaVersion: 1,
    mode: 'snapshot',
    staging: null,
    visibilityRevision: null,
    costVisibility: 'hidden',
    costsReady: false,
    status: 'initial',
    error: null,
    checkedAt: null,
    asOf: null,
    gaps: [],
  }
}

/** No counter/model/valuation revision is substituted for another revision axis. */
export function platformObservationRevision(item: PlatformObservation): number {
  return item.kind === 'usage'
    ? item.projection.projectionRevision
    : item.kind === 'valuation'
      ? item.valuationRevision
      : item.revision
}
export function platformObservationKey(item: PlatformObservation, kind = item.kind): string {
  const i = item.identity
  return JSON.stringify([
    kind,
    i.projectId,
    i.taskId,
    i.subtaskId,
    i.executionId,
    i.executionGeneration,
    item.sourceId,
    item.recordId,
  ])
}
export function hidePlatformAmount(
  item: PlatformObservation,
  availability: 'pending' | 'not-authorized',
): PlatformObservation {
  return item.kind !== 'valuation'
    ? item
    : {
        ...item,
        availability,
        priceVersionRef: null,
        amountDecimal: null,
        completeness: 'unknown',
      }
}
export class PlatformSyncError extends Error {
  constructor(
    readonly code: 'binding-conflict' | 'revision-conflict' | 'page-conflict',
    message: string,
  ) {
    super(message)
    this.name = 'PlatformSyncError'
  }
}
