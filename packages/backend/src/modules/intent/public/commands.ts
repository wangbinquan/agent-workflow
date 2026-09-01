export interface IntentScratchSweepInput {
  readonly retentionHours: number
  readonly now?: number
}

export interface IntentScratchMaintenanceCommand {
  sweep(input: IntentScratchSweepInput): Promise<{ readonly removed: number }>
}

export interface IntentBootRecoveryInput {
  readonly recoverTurnIds: readonly string[]
  readonly activeIntentApplyJournalIds: readonly string[]
  readonly activeBundleApplyIds: readonly string[]
  readonly now?: number
}

export interface IntentRecoveryCommand {
  bootTurnIds(): Promise<readonly string[]>
  recover(input: IntentBootRecoveryInput): Promise<{
    readonly failed: number
    readonly rolledForward: number
    readonly queuedWorkingSets: number
    readonly orphanedTurns: number
    readonly queuedSessionIds: readonly string[]
  }>
}

export interface IntentMaintenanceCommands {
  readonly scratch: IntentScratchMaintenanceCommand
  readonly recovery: IntentRecoveryCommand
}
