import type { FileNode } from '@agent-workflow/shared'

/** Content is selected by the version already read by AW, never by a mutable name. */
export interface SkillContentReference {
  readonly id: string
  readonly name: string
  readonly contentVersion: number
}

/**
 * Physical reads only. AW retains availability, metadata, frontmatter and token
 * projection. Every method reads the requested immutable version; the local
 * adapter retains the existing live-directory fallback for pre-version skills.
 */
export interface SkillContentReader {
  readMain(reference: SkillContentReference): string | Promise<string>
  listFiles(reference: SkillContentReference): FileNode[] | Promise<FileNode[]>
  readFile(reference: SkillContentReference, path: string): string | Promise<string>
}
