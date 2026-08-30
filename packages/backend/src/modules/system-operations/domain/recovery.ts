// RFC-346 — recovery administration facts. Physical restore mechanics remain
// in the RFC-213 legacy adapter until RFC-294 W9-E.

export type RestoreDirection = 'same' | 'forward' | 'downgrade'

export interface AdminRestorePlan {
  readonly backupKind: string | null
  readonly backupMigrationCreatedAt: number | null
  readonly binaryMigrationCreatedAt: number
  readonly direction: RestoreDirection
}

export interface AdminRecoveryStatus {
  readonly pending: Readonly<{
    requestedAt: number
    stagedBytes: number | null
    noMigrate: boolean
    skipIntegrityCheck: boolean
  }> | null
  readonly failed: ReadonlyArray<
    Readonly<{
      dir: string
      failedAt: number | null
      error: string | null
    }>
  >
}

export type LocalRestoreActivation =
  | Readonly<{
      status: 'completed'
      direction: RestoreDirection
      safetyBackupPath: string | null
      migrated: boolean
      restored: Readonly<{ db: boolean; config: boolean; skills: boolean }>
    }>
  | Readonly<{ status: 'daemon-running'; pid: number }>
  | Readonly<{ status: 'lock-unavailable' }>

export function projectAdminRecoveryStatus(status: AdminRecoveryStatus): AdminRecoveryStatus {
  return Object.freeze({
    pending:
      status.pending === null
        ? null
        : Object.freeze({
            requestedAt: status.pending.requestedAt,
            stagedBytes: status.pending.stagedBytes,
            noMigrate: status.pending.noMigrate,
            skipIntegrityCheck: status.pending.skipIntegrityCheck,
          }),
    failed: Object.freeze(
      status.failed.map((failure) =>
        Object.freeze({
          dir: failure.dir,
          failedAt: failure.failedAt,
          error: failure.error,
        }),
      ),
    ),
  })
}
