// RFC-370 §10 V20 — the workspace a memory→skill fusion engine task edits.
//
// Knowledge Evolution owns the fusion and Resource Catalog owns the skill
// bytes; the Git working copy the agent edits is Source Control's. The
// selected adapter seeds it from exact skill bytes (a baseline commit plus an
// optional uncommitted overlay), reads back the proposal (the diff against that
// baseline, the agent's result manifest and the complete edited tree) and gives
// the workspace back once the engine task no longer needs it.

/** One file of a skill tree (SKILL.md included), as exact bytes. */
export interface FusionWorkspaceFile {
  readonly path: string
  readonly content: Uint8Array
}

export interface FusionWorkspacePreparation {
  readonly worktreePath: string
  readonly baseCommit: string
}

/** The agent's result manifest as the workspace holds it; KE parses it. */
export type FusionWorkspaceManifest =
  | { readonly kind: 'missing' }
  | { readonly kind: 'not-a-file' }
  | { readonly kind: 'file'; readonly text: string }

export interface FusionWorkspaceResult {
  /** Worktree diff against the baseline commit, untracked files included. */
  readonly diff: string
  readonly manifest: FusionWorkspaceManifest
  /** Every skill file of the working copy (`.git` and the platform directory excluded). */
  readonly files: readonly FusionWorkspaceFile[]
}

export interface FusionWorkspaceEffects {
  /** A fresh workspace: `base` committed as the baseline, then `overlay` (when
   * given) written over it as uncommitted changes. A failed preparation leaves
   * nothing behind. */
  prepare(request: {
    readonly fusionId: string
    readonly iteration: number
    readonly taskId: string
    readonly base: readonly FusionWorkspaceFile[]
    readonly overlay: readonly FusionWorkspaceFile[] | null
  }): Promise<FusionWorkspacePreparation>
  collect(request: {
    readonly taskId: string
    readonly worktreePath: string
    readonly baseCommit: string
  }): Promise<FusionWorkspaceResult>
  /** `abandon`: the engine task was never admitted. `finished`: its proposal
   * has been collected (or it settled without one). Idempotent. */
  release(request: {
    readonly taskId: string
    readonly worktreePath: string
    readonly mode: 'abandon' | 'finished'
  }): Promise<void>
}
