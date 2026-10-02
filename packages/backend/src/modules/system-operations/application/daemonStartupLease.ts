import type {
  DaemonStartupLease,
  DaemonStartupLeasePort,
  DaemonStartupRecoveryAuthority,
} from './ports/daemonStartupLease'

export async function acquireDaemonStartupLease(
  effects: DaemonStartupLeasePort,
): Promise<DaemonStartupLease> {
  return await effects.acquire()
}

/** A failed boot releases the selected startup claim before returning its error. */
export async function runDaemonStartupWithLease<T>(
  lease: DaemonStartupLease,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run()
  } catch (error) {
    try {
      await lease.release()
    } catch (releaseError) {
      throw new AggregateError(
        [error, releaseError],
        'daemon startup failed and startup authority release failed',
      )
    }
    throw error
  }
}

export async function readDaemonStartupRecoveryAuthority(
  lease: DaemonStartupLease,
  daemonGeneration: string,
): Promise<DaemonStartupRecoveryAuthority> {
  const receipt = await lease.recoveryAuthority({ daemonGeneration })
  if (
    receipt.daemonGeneration !== daemonGeneration ||
    receipt.receiptDigest.length === 0 ||
    !Number.isFinite(receipt.acquiredAt)
  ) {
    throw new Error('daemon-startup-recovery-authority-invalid')
  }
  return receipt
}
