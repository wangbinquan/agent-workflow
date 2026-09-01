export interface EmployeeCaseWorkspaceRow {
  readonly caseId: string
  readonly repositoryId: string
  readonly cachedRepoId: string
  readonly baselineSha: string
  readonly targetBranch: string
  readonly sourceBranch: string
  readonly remoteHeadSha: string | null
  readonly state: 'active' | 'published' | 'released'
  readonly createdAt: number
  readonly updatedAt: number
}

export interface EmployeeRoundWorkspaceStateRow {
  readonly roundId: string
  readonly attemptOrdinal: number
  readonly caseId: string
  readonly baselineSha: string
  readonly preStateJson: string
  readonly checkpointDigest: string
  readonly validationJson: string | null
  readonly createdAt: number
  readonly updatedAt: number
}

export interface EmployeeWorkspacePersistence {
  workspace(caseId: string): Promise<EmployeeCaseWorkspaceRow | null>
  insertWorkspace(row: EmployeeCaseWorkspaceRow): Promise<void>
  repositoryLocalPath(cachedRepoId: string): Promise<string | null>
  latestRoundState(roundId: string): Promise<EmployeeRoundWorkspaceStateRow | null>
  roundState(
    roundId: string,
    attemptOrdinal: number,
  ): Promise<EmployeeRoundWorkspaceStateRow | null>
  insertRoundState(row: EmployeeRoundWorkspaceStateRow, conflict: 'error' | 'ignore'): Promise<void>
  upsertRoundState(row: EmployeeRoundWorkspaceStateRow): Promise<void>
  updateRoundState(input: {
    readonly roundId: string
    readonly attemptOrdinal: number
    readonly patch: Partial<
      Pick<EmployeeRoundWorkspaceStateRow, 'preStateJson' | 'validationJson' | 'updatedAt'>
    >
  }): Promise<void>
}
