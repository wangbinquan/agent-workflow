export interface SkillVersionRecoveryPlan {
  readonly skillId: string
  readonly operationId: string
  readonly version: number
  readonly publicationId: string
  readonly rootRef: string
  readonly liveRef: string
  readonly stagingRef: string
  readonly versionRef: string
}

/** Recovery effects selected from AW's durable operation and committed metadata. */
export interface SkillVersionRecoveryContentStore {
  plan(input: {
    readonly skillId: string
    readonly operationId: string
    readonly legacyName?: string
    readonly version: number
    readonly stagingReference: string
    readonly versionReference: string
  }): SkillVersionRecoveryPlan
  matchesVersionReference(plan: SkillVersionRecoveryPlan, reference: string): boolean
  rollback(plan: SkillVersionRecoveryPlan): void | Promise<void>
  rollForward(plan: SkillVersionRecoveryPlan, contentHash: string): void | Promise<void>
}
