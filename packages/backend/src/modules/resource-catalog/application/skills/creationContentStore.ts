export interface SkillTreeFiles {
  readonly files: readonly { readonly path: string; readonly content: Uint8Array }[]
  readonly mainContent: string
}

/** Initial content is prepared by AW; the adapter only materializes its bytes. */
export type SkillInitialContent =
  | { readonly kind: 'main'; readonly content: string }
  | ({ readonly kind: 'files' } & SkillTreeFiles)

export interface SkillContentRoot {
  readonly skillId: string
  readonly rootRef: string
}

export interface SkillCreationContentPlan extends SkillContentRoot {
  readonly liveRef: string
}

/**
 * Creation's physical effects only. AW owns reserve/ready transitions and the
 * original best-effort cleanup policy. References must be reproducible from the
 * immutable skill id so the same adapter can service restart recovery.
 */
export interface SkillCreationContentStore {
  plan(skillId: string): SkillCreationContentPlan
  initialize(plan: SkillCreationContentPlan, content: SkillInitialContent): void | Promise<void>
  discard(root: SkillContentRoot): void | Promise<void>
}
