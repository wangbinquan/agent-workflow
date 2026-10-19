// RFC-370 §10 V16 — the revision and worktree content a code review reads.
//
// The task "Changes" views (structural diff, change narrative, file content,
// file symbols, code intelligence, call-chain expansion) used to run `git` and
// read files on the daemon host. A hosted task's worktree is a `cs-workspace:`
// volume reference, so every one of them answered 410. This port binds one
// workspace reference and offers exactly the reads those views make; the
// selected adapter decides where they run (the daemon host, or the task volume).

/** What a workspace reference names right now. */
export type RepositoryPresence = 'git' | 'directory' | 'absent'

/** One changed file. Renames arrive as one entry whose old side is `oldPath`. */
export interface RevisionChangeEntry {
  /** Current (new-side) repository-relative path. */
  readonly path: string
  /** Pre-rename path when Git detected a rename (`status === 'R'`). */
  readonly oldPath?: string
  /** A added, M modified, D deleted, R renamed, T type change (read as M). */
  readonly status: 'A' | 'M' | 'D' | 'R' | 'T'
}

export interface RevisionLineStat {
  readonly added: number
  readonly removed: number
}

export interface RevisionChangesRequest {
  /** The base revision. */
  readonly from: string
  /** The target revision; absent = the live worktree (tracked and untracked). */
  readonly to?: string
  /** Also count added/removed lines per file (worktree target only). */
  readonly lineStats?: boolean
}

export interface RevisionChanges {
  readonly entries: readonly RevisionChangeEntry[]
  /** Per-file line counts keyed by the new path; present when requested. */
  readonly lineStats?: ReadonlyMap<string, RevisionLineStat>
}

/** One file read. `binary` = a NUL byte in its first 8 KiB. */
export type RevisionFileRead =
  | { readonly kind: 'text'; readonly content: string; readonly size: number }
  | { readonly kind: 'absent' }
  | { readonly kind: 'oversized'; readonly size: number }
  | { readonly kind: 'binary' }

/** A worktree read additionally refuses a path that resolves outside the worktree. */
export type WorktreeFileRead = RevisionFileRead | { readonly kind: 'outside' }

export interface RevisionReadRequest {
  readonly rev: string
  readonly paths: readonly string[]
  readonly maxBytes: number
}

export interface WorktreeReadRequest {
  readonly path: string
  readonly maxBytes: number
}

/** Class/interface name → the repository-relative files declaring it. */
export type RepositoryClassIndex = ReadonlyMap<string, readonly string[]>

/** Whether an external SCIP indexer can run against this content, and where. */
export type RevisionContentCapabilities =
  | { readonly indexing: false }
  | {
      readonly indexing: true
      /** The checkout an indexer process runs in (a path on this host). */
      readonly indexRoot: string
    }

export interface RepositoryRevisionContent {
  readonly capabilities: RevisionContentCapabilities
  presence(): Promise<RepositoryPresence>
  /** Throws a typed error when Git cannot enumerate (for example a pruned snapshot). */
  changes(request: RevisionChangesRequest): Promise<RevisionChanges>
  /** One answer per requested path; a path the revision lacks reads `absent`. */
  readRevision(request: RevisionReadRequest): Promise<ReadonlyMap<string, RevisionFileRead>>
  readWorktree(request: WorktreeReadRequest): Promise<WorktreeFileRead>
  /** Worktree files (tracked and untracked) containing any fixed-string pattern. */
  grep(patterns: readonly string[]): Promise<readonly string[]>
  classIndex(): Promise<RepositoryClassIndex>
  /** Changes with any byte of the worktree (HEAD, status and dirty file content). */
  snapshotDigest(): Promise<string>
}

/** The selected owner interprets the reference; a binding never changes receiver. */
export interface RepositoryRevisionContentFactory {
  bind(workspaceRef: string): RepositoryRevisionContent
}
