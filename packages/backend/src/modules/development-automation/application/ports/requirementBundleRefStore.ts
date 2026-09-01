export type RequirementBundleRefPurpose =
  | 'direct-submission'
  | 'requirement-bundle'
  | 'requirement-manifest'
  | 'question-set'
  | 'answer-set'

export interface RequirementBundleRefRecord {
  readonly id: string
  readonly missionId: string
  readonly purpose: RequirementBundleRefPurpose
  readonly evidenceRef: string
  readonly manifestDigest: string
  readonly fileCount: number
  readonly totalBytes: number
  readonly retentionState: 'active' | 'expired'
  readonly createdAt: number
}

export interface RequirementBundleRefPersistence {
  insert(record: RequirementBundleRefRecord): Promise<void>
  get(id: string): Promise<RequirementBundleRefRecord | null>
  latest(
    missionId: string,
    purpose: RequirementBundleRefPurpose,
  ): Promise<RequirementBundleRefRecord | null>
  findManifest(
    missionId: string,
    manifestDigest: string,
  ): Promise<RequirementBundleRefRecord | null>

  /** Copies the latest three requirement pointers in one provider transaction. */
  copyLatestRequirements(input: {
    readonly fromMissionId: string
    readonly toMissionId: string
    readonly copies: readonly Readonly<{
      readonly purpose: Extract<
        RequirementBundleRefPurpose,
        'direct-submission' | 'requirement-bundle' | 'requirement-manifest'
      >
      readonly id: string
    }>[]
    readonly createdAt: number
  }): Promise<number>
}
