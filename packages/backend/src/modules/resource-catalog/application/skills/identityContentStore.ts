export interface SkillMigrationIdentity {
  readonly skillId: string
  readonly legacyName: string
}

export interface SkillIdentityMigrationPlan extends SkillMigrationIdentity {
  readonly legacyRef: string
  readonly canonicalRef: string
}

/** Physical identity migration; AW owns the durable operation and DB phases. */
export interface SkillIdentityContentStore {
  plan(identity: SkillMigrationIdentity): SkillIdentityMigrationPlan
  captureSource(plan: SkillIdentityMigrationPlan): string | Promise<string>
  move(plan: SkillIdentityMigrationPlan, fingerprint: string): void | Promise<void>
  rollback(plan: SkillIdentityMigrationPlan, fingerprint: string): void | Promise<void>
  rollForward(plan: SkillIdentityMigrationPlan, fingerprint: string): void | Promise<void>
}
