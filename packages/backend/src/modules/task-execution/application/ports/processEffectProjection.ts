import type { OwnershipToken } from '../../domain/ownership'

/** The application classifies outcomes; the selected execution participant
 * owns the request fingerprint, recovery dialect and persisted receipt. */
export interface ProcessEffectOutcome {
  readonly outcome: string
}

export interface ProcessEffectDescription {
  readonly requestHash: string
  readonly resourceKeys: readonly string[]
  readonly recoveryClass: string
  readonly classifierVersion: string
  readonly transportPolicyVersion: string
}

export interface ProcessEffectSpawnIdentity<TReceipt> {
  readonly token: OwnershipToken
  readonly effectId: string
  readonly attemptId: string
  readonly nodeRunId: string
  readonly receipt: TReceipt
  readonly runtimeParamsJson?: string
  readonly now: number
}

/** Receipt types remain opaque to the coordinator. In particular, a remote
 * execution reference never needs a PID-shaped application contract. */
export interface ProcessEffectProjection<TReceipt, TResult extends ProcessEffectOutcome> {
  describe(): ProcessEffectDescription
  recordSpawnReceipt(input: ProcessEffectSpawnIdentity<TReceipt>): Promise<void>
  settlementReceipt(result: TResult): string
}
