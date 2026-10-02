// RFC-370 A4 — bound candidate repositories and content effects.
// References are opaque to shared orchestration; relative business paths,
// staging policy, upload lineage and commit decisions remain owned by AW.

type Completion<T> = T | Promise<T>

export interface RepositoryCandidateGitOutcome {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

export interface RepositoryCandidateGitOptions {
  readonly env?: Record<string, string | undefined>
  readonly stdin?: string
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

export interface RepositoryCandidateFileFacts {
  readonly kind: 'directory' | 'file' | 'symlink' | 'other'
  readonly mode: number
}

export interface RepositoryCandidateWorkspace {
  readonly reference: string
  cloneBaseline(): Completion<RepositoryCandidateGitOutcome>
  run(
    args: readonly string[],
    options?: RepositoryCandidateGitOptions,
  ): Completion<RepositoryCandidateGitOutcome>
  listCandidateRoot(): Completion<readonly string[]>
  removeCandidateEntry(relativePath: string): Completion<void>
  statOverlay(relativePath: string): Completion<RepositoryCandidateFileFacts>
  listOverlay(relativeDirectory: string): Completion<readonly string[]>
  copyOverlayFile(relativePath: string): Completion<void>
  statCandidate(relativePath: string): Completion<RepositoryCandidateFileFacts | null>
  setCandidateMode(relativePath: string, mode: number): Completion<void>
  readCandidateDigest(relativePath: string): Completion<string | null>
  importCommitToBaseline(input: {
    readonly commitSha: string
    readonly localRef: string
  }): Completion<RepositoryCandidateGitOutcome>
  close(): Completion<void>
}

export interface RepositoryCandidateSession {
  runBaseline(
    args: readonly string[],
    options?: RepositoryCandidateGitOptions,
  ): Completion<RepositoryCandidateGitOutcome>
  createWorkspace(): Completion<RepositoryCandidateWorkspace>
  close(): Completion<void>
}

export interface RepositoryCandidateEffectsFactory {
  acquire(input: {
    readonly baselineReference: string
    readonly overlayReference: string
  }): Completion<RepositoryCandidateSession>
}
