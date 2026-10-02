/** Startup exclusivity is a host capability; diagnostic fields are not authority. */
export interface DaemonStartupRecoveryAuthority {
  readonly daemonGeneration: string
  readonly acquiredAt: number
  readonly receiptDigest: string
}

export interface DaemonStartupLease {
  readonly diagnostics: Readonly<Record<string, unknown>>
  recoveryAuthority(input: {
    readonly daemonGeneration: string
    readonly now?: number
  }): DaemonStartupRecoveryAuthority | Promise<DaemonStartupRecoveryAuthority>
  /** Idempotent; an orderly failure or shutdown waits for the release ACK. */
  release(): void | Promise<void>
  /** Best effort synchronous exit hook, separate from an orderly release. */
  releaseOnExit(): void
}

export interface DaemonStartupLeasePort {
  acquire(): DaemonStartupLease | Promise<DaemonStartupLease>
}
