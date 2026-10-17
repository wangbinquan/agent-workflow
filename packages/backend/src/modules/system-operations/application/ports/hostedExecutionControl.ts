// RFC-370 v2 §3.2 / §5.2 — the application side of the CrewStation execution
// fence. The platform fences every execution mutation by `{epoch, leaseId,
// instanceId}`; this instance mirrors the lease it holds into its own
// database so a transaction that records a hosted effect can prove, under a row
// lock, that no newer holder exists. Standalone never writes the row.
//
// RFC-370 v3 V7 — the same row carries the database write window: while the
// platform freezes the service for a migration or a database restore, the
// frozen record names that operation and every hosted write is refused.

export type HostedExecutionPhase = 'frozen' | 'preparing' | 'active'

export interface HostedExecutionControlRecord {
  readonly epoch: number
  /** The holding instance; null while frozen. */
  readonly owner: string | null
  readonly phase: HostedExecutionPhase
  readonly leaseId: string | null
  /** Platform lease expiry (ms epoch); null while frozen. */
  readonly expiresAt: number | null
  /**
   * Set on a frozen record: the platform operation (migration or database
   * restore) that closes the database write window. A frozen record without it
   * keeps the current window; the next non-frozen record reopens it.
   */
  readonly migrationOperationId?: string
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

/** A same-epoch record that would move the lease backwards (or to another holder). */
export class HostedExecutionControlRegressionError extends Error {
  constructor() {
    super('hosted-execution-control-phase-regression')
    this.name = 'HostedExecutionControlRegressionError'
  }
}

export interface HostedExecutionControlStore {
  /**
   * Record the platform state; never moves the epoch backwards. Renewing the
   * held lease never waits for in-flight writes; any other transition waits
   * until every write that relied on the previous state has committed. Closing
   * or reopening the write window additionally drains every admitted write.
   */
  write(record: HostedExecutionControlRecord): Promise<void>
  read(): Promise<HostedExecutionControlRecord | null>
}
