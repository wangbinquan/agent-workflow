// The existing five-class merge manifest; no execution or filesystem effects.
export type MergeConflictType =
  | 'content'
  | 'modify-delete'
  | 'rename-delete'
  | 'binary'
  | 'submodule'

export interface MergeConflictEntry {
  /** Per-repo worktree dir name (multi-repo disambiguation). */
  worktreeDirName: string
  /** Conflicted path relative to that repo root. */
  path: string
  type: MergeConflictType
}

export type MergeConflictManifest = MergeConflictEntry[]
