/** Storage maintenance for legacy adoption and boot reconciliation. */
export interface SkillLifecycleContentStore {
  hasLiveMain(skillId: string): boolean | Promise<boolean>
  /** No main content means no adoption; otherwise capture the immutable v1. */
  captureInitial(skillId: string): string | null | Promise<string | null>
  /** Inspection failures must never be reported as an empty root. */
  isRootEmpty(skillId: string): boolean | Promise<boolean>
  removeRoot(skillId: string): void | Promise<void>
  /** Preserve an existing live tree; only restore a missing live main. */
  restoreLiveIfMissing(skillId: string, version: number): void | Promise<void>
}

export interface SkillSnapshotInspectionVersion {
  readonly version: number
  readonly reference: string
  readonly contentHash: string
}

export type SkillSnapshotInspection =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string }

/** AW selects the complete history and committed version; storage inspects bytes. */
export interface SkillSnapshotInspector {
  inspect(input: {
    readonly skillId: string
    readonly currentVersion: number
    readonly versions: readonly SkillSnapshotInspectionVersion[]
  }): SkillSnapshotInspection | Promise<SkillSnapshotInspection>
}
