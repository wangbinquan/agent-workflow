import type { SkillContentReference } from './contentReader'

export interface SkillPackageContentEntry {
  readonly path: string
  readonly bytes: Uint8Array
}

/** Complete byte tree including SKILL.md; AW projects package metadata. */
export interface SkillPackageContentReader {
  readTree(
    reference: SkillContentReference,
  ): readonly SkillPackageContentEntry[] | Promise<readonly SkillPackageContentEntry[]>
}
