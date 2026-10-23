import type { SkillTextViewPolicy } from './textView'
import type { FileNode } from '@agent-workflow/shared'

/** The immutable historical version selected and authorized by AW. */
export interface SkillVersionReadReference {
  readonly skillId: string
  readonly version: number
}

export type SkillVersionTreeEntry = Uint8Array

export interface SkillVersionSnapshotContent {
  readonly main: Uint8Array | null
  readonly files: readonly FileNode[]
}

/** Snapshot-only reads: a missing historical tree never falls back to live. */
export interface SkillVersionContentReader extends SkillTextViewPolicy {
  readSnapshot(
    reference: SkillVersionReadReference,
  ): SkillVersionSnapshotContent | Promise<SkillVersionSnapshotContent>
  readTree(
    reference: SkillVersionReadReference,
  ):
    | ReadonlyMap<string, SkillVersionTreeEntry>
    | Promise<ReadonlyMap<string, SkillVersionTreeEntry>>
}
