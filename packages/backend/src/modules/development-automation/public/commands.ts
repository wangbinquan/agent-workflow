// Public maintenance commands owned by the development-automation context.
// The Worker bootstrap composes the SQLite implementation once; the platform
// runner receives only this owner-facing command port.

export interface DevelopmentRetentionSweepResult {
  readonly missionsScanned: number
  readonly prunedAttempts: number
  readonly markedBundleRefs: number
  readonly expiredBundleRefsPending: number
}

export interface DevelopmentAutomationMaintenanceCommands {
  sweepExpiredUploads(now: number, limit: number): number
  sweepRetention(now: number): Promise<DevelopmentRetentionSweepResult>
}
