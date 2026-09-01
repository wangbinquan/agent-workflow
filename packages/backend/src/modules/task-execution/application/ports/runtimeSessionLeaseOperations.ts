export type RuntimeSessionLeaseProtocol = 'opencode' | 'claude-code'

export interface RuntimeSessionLease {
  readonly protocol: RuntimeSessionLeaseProtocol
  readonly sessionId: string
  readonly taskId: string
  readonly nodeId: string
  readonly createdNodeRunId: string
  readonly leaseNodeRunId: string | null
  readonly leaseNonceDigest: string | null
  readonly leasedAt: number | null
  readonly resetPending: boolean
}

export interface RuntimeSessionLeaseToken {
  readonly protocol: RuntimeSessionLeaseProtocol
  readonly sessionId: string
  readonly nodeRunId: string
  readonly leaseNonceDigest: string
}

export interface RuntimeSessionLeaseClaimInput {
  readonly protocol: RuntimeSessionLeaseProtocol
  readonly sessionId: string
  readonly taskId: string
  readonly nodeId: string
  readonly currentNodeRunId: string
  readonly leaseNonceDigest: string
  readonly leasedAt?: number
}

export interface NormalizedRuntimeSessionLeaseClaimInput extends Omit<
  RuntimeSessionLeaseClaimInput,
  'leasedAt'
> {
  readonly leasedAt: number
}

export class RuntimeSessionLeaseError extends Error {
  readonly code = 'runtime-session-conflict' as const

  constructor(readonly reason: string) {
    super('runtime-session-conflict')
    this.name = 'RuntimeSessionLeaseError'
  }
}

/** Bootstrap-selected, provider-neutral runtime conversation lease atom. */
export interface RuntimeSessionLeaseOperations {
  load(
    protocol: RuntimeSessionLeaseProtocol,
    sessionId: string,
  ): Promise<RuntimeSessionLease | undefined>
  claimNew(input: NormalizedRuntimeSessionLeaseClaimInput): Promise<RuntimeSessionLeaseToken>
  preclaimResume(input: NormalizedRuntimeSessionLeaseClaimInput): Promise<RuntimeSessionLeaseToken>
  confirmResume(token: RuntimeSessionLeaseToken): Promise<boolean>
  rotate(token: RuntimeSessionLeaseToken, nextSessionId: string): Promise<RuntimeSessionLeaseToken>
  markResetPending(token: RuntimeSessionLeaseToken): Promise<boolean>
  discard(token: RuntimeSessionLeaseToken): Promise<boolean>
  release(token: RuntimeSessionLeaseToken): Promise<boolean>
  repairAfterOrphanReap(nodeRunId?: string): Promise<number>
}
