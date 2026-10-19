import type { SkillPackageContentEntry } from './packageContentReader'

/**
 * RFC-370 §10 V20 — exact skill trees a memory→skill fusion needs from the
 * selected skill storage: the immutable tree of one version (a missing
 * snapshot is `null`, never the live tree) and fusion proposals kept as
 * candidate trees until they are applied or dropped. Candidates belong to
 * their skill and are removed with it.
 */
export interface SkillTreeContentStore {
  readVersion(input: {
    readonly skillId: string
    readonly version: number
  }): Promise<readonly SkillPackageContentEntry[] | null>
  writeCandidate(input: {
    readonly skillId: string
    readonly candidateId: string
    readonly files: readonly SkillPackageContentEntry[]
  }): Promise<void>
  readCandidate(input: {
    readonly skillId: string
    readonly candidateId: string
  }): Promise<readonly SkillPackageContentEntry[] | null>
  discardCandidate(input: { readonly skillId: string; readonly candidateId: string }): Promise<void>
}

/** Candidate ids are ULIDs minted by the fusion that captured them. */
export const SKILL_CANDIDATE_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/
