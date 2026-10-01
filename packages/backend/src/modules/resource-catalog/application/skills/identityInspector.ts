export interface SkillIdentityInventoryRow {
  readonly id: string
  readonly name: string
  /** Computed by AW from managed_path and all version references. */
  readonly canonicalMetadata: boolean
}

export interface SkillIdentityOperationInspection {
  readonly opId: string
  readonly skillId: string
  readonly kind: 'reserve' | 'version-write' | 'delete' | 'migrate'
  readonly legacyName?: string
  readonly stagingPath: string | null
  readonly candidatePath: string | null
  readonly backupPath: string | null
}

export interface SkillIdentityHuskPlan {
  readonly skillId: string
  readonly contentRefs: readonly string[]
}

export interface SkillIdentityHuskSweep {
  plan(input: {
    readonly id: string
    readonly name: string
  }): SkillIdentityHuskPlan | null | Promise<SkillIdentityHuskPlan | null>
  discard(plan: SkillIdentityHuskPlan): void | Promise<void>
}

/** Storage proofs for AW-selected rows/operations; no database or phase writes. */
export interface SkillIdentityInspector {
  prepare(): void | Promise<void>
  assertOwnership(
    rows: readonly SkillIdentityInventoryRow[],
    operations: readonly SkillIdentityOperationInspection[],
  ): void | Promise<void>
  needsMigration(row: SkillIdentityInventoryRow): boolean | Promise<boolean>
  prepareHuskSweep(
    rows: readonly SkillIdentityInventoryRow[],
  ): SkillIdentityHuskSweep | Promise<SkillIdentityHuskSweep>
  assertCanonicalRoot(skillId: string): void | Promise<void>
  assertCanonicalLive(skillId: string): void | Promise<void>
  assertCanonicalVersion(skillId: string, version: number): void | Promise<void>
  assertNoResidue(): void | Promise<void>
  assertPublishedReserve(input: {
    readonly skillId: string
    readonly legacyName?: string
    readonly operationId: string
    readonly contentHash: string
  }): void | Promise<void>
  assertCommittedDelete(input: {
    readonly skillId: string
    readonly legacyName?: string
    readonly operationId: string
    readonly backupReference: string
  }): void | Promise<void>
}
