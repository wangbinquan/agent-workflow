/** Operation-scoped references stay durable across retries and process restarts. */
export interface SkillDeletionContentPlan {
  readonly skillId: string
  readonly operationId: string
  readonly rootRef: string
  readonly backupRef: string
  readonly backupJournalRef: string
}

/** Reversible content effects; AW owns delete intent, DB commit and lock release. */
export interface SkillDeletionContentStore {
  plan(input: {
    readonly skillId: string
    readonly operationId: string
    readonly legacyName?: string
    readonly recordedBackupRef?: string | null
  }): SkillDeletionContentPlan
  stage(plan: SkillDeletionContentPlan): void | Promise<void>
  rollback(plan: SkillDeletionContentPlan, recovery: boolean): void | Promise<void>
  discard(plan: SkillDeletionContentPlan): void | Promise<void>
}
