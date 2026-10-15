// RFC-370 v2 §3.2 / §5.2 — the application side of the CrewStation execution
// fence. The platform fences every execution mutation by `{epoch, leaseId,
// instanceId}`; this instance mirrors the lease it holds into its own
// database so a transaction that records a hosted effect can prove, under a row
// lock, that no newer holder exists. Standalone never writes the row.

export type HostedExecutionPhase = 'frozen' | 'preparing' | 'active'

export interface HostedExecutionControlRecord {
  readonly epoch: number
  /** The holding instance; null while frozen. */
  readonly owner: string | null
  readonly phase: HostedExecutionPhase
  readonly leaseId: string | null
  /** Platform lease expiry (ms epoch); null while frozen. */
  readonly expiresAt: number | null
}

export class HostedExecutionControlStaleError extends Error {
  constructor(
    readonly storedEpoch: number,
    readonly attemptedEpoch: number,
  ) {
    super(`execution control epoch ${attemptedEpoch} is older than the stored ${storedEpoch}`)
    this.name = 'HostedExecutionControlStaleError'
  }
}

export interface HostedExecutionControlStore {
  /** Record the platform state; never moves the epoch backwards. */
  write(record: HostedExecutionControlRecord): Promise<void>
  read(): Promise<HostedExecutionControlRecord | null>
}
