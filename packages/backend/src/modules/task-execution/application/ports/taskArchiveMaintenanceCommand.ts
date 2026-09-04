export interface TaskArchiveConfig {
  readonly enabled: boolean
  readonly retentionDays: number
  readonly maxTreesPerSweep?: number
}

export interface TaskArchiveMaintenanceOptions {
  readonly archiveDir: string
  readonly runsDir: string
  readonly logsDir: string
  readonly now?: number
}

export interface ArchivedTaskTreeReceipt {
  readonly rootTaskId: string
  readonly taskIds: readonly string[]
  readonly rows: Readonly<Record<string, number>>
  readonly dir: string
}

export interface TaskArchiveSweepReceipt {
  readonly archived: readonly ArchivedTaskTreeReceipt[]
  readonly skipped: number
}

export interface TaskArchivePreviewTree {
  readonly rootTaskId: string
  readonly taskCount: number
  readonly lastFinishedAt: number
}

export interface TaskArchiveRecoveryReceipt {
  readonly promoted: readonly string[]
  readonly discarded: readonly string[]
}

export interface TaskArchiveManualRequest {
  readonly retentionDays: number
  readonly maxTrees: number
  readonly actorUserId: string | null
  readonly now?: number
}

/** Provider-selected destructive maintenance command; database clients stay in its adapter. */
export interface TaskArchiveMaintenanceCommand {
  runSweep(
    config: TaskArchiveConfig,
    options: TaskArchiveMaintenanceOptions,
  ): Promise<TaskArchiveSweepReceipt>
  preview(input: {
    readonly retentionDays: number
    readonly maxTrees: number
    readonly now?: number
  }): Promise<readonly TaskArchivePreviewTree[]>
  runManual(
    input: TaskArchiveManualRequest,
    options: TaskArchiveMaintenanceOptions,
  ): Promise<TaskArchiveSweepReceipt>
  /** RFC-359 W3-T15-B：boot 时续做崩溃留下的 archive / retention 认领，并收尾 `.tmp-*` 残留。 */
  recover(options: TaskArchiveMaintenanceOptions): Promise<TaskArchiveRecoveryReceipt>
}
