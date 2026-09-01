import type { OwnershipToken } from '../../domain/ownership'

export interface ClaimedClarifyContinuation {
  readonly operationId: string
  readonly gateRef: string
  readonly originNodeRunId: string
}

export type GateContinuationInspection =
  | Readonly<{ kind: 'ready' }>
  | Readonly<{ kind: 'clarify'; continuation: ClaimedClarifyContinuation }>

/** Provider-neutral atom for the clarify convergence phase that precedes the
 * ordinary rollback effect step. The adapter owns the exact claimed-intent
 * fence and the retry release CAS; no generic transaction escapes. */
export interface GateContinuationPreDrivePersistence {
  inspect(input: {
    readonly taskId: string
    readonly intentId: string
    readonly token: OwnershipToken
  }): Promise<GateContinuationInspection>

  hasUndispatchedClarifyWork(input: {
    readonly taskId: string
    readonly originNodeRunId: string
  }): Promise<boolean>

  releaseClarifyForRetry(input: {
    readonly taskId: string
    readonly intentId: string
    readonly token: OwnershipToken
    readonly now: number
  }): Promise<void>
}
