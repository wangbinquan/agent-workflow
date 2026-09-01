export interface DigitalEmployeeWriterState {
  readonly activeGeneration: number
  readonly mode: 'pre-cutover' | 'legacy-draining' | 'os-active'
  readonly legacyAdmissionsEnabled: boolean
  readonly legacyOpenMissionCount: number
  readonly updatedAt: number
}

export interface LegacyMissionDrainEntry {
  readonly missionId: string
  readonly status: string
  readonly activeMrClaimCount: number
  readonly childLinkCount: number
  readonly pendingApprovalCount: number
}

export interface LegacyMissionDrainReport {
  readonly truncated: boolean
  readonly entries: readonly LegacyMissionDrainEntry[]
}

/** Provider-owned atomic writer-state/drain aggregate. No transaction leaks. */
export interface DigitalEmployeeWriterCutoverPersistence {
  read(): Promise<DigitalEmployeeWriterState>
  activate(input: {
    readonly now: number
    readonly legacyAdmissionsEnabled: boolean
  }): Promise<DigitalEmployeeWriterState>
  refresh(now: number): Promise<DigitalEmployeeWriterState>
  migrationSnapshot(limit: number): Promise<{
    readonly writer: DigitalEmployeeWriterState
    readonly drain: LegacyMissionDrainReport
  }>
}
