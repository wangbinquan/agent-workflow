import type {
  CommitPreparedResult,
  PrepareRepositoryCommitResult,
  RepositoryCommitPreviewResult,
  RepositoryPublishMode,
  RepositoryPublishResult,
  WorkspaceExcludeProfileReceipt,
} from './types'

/** A worktree-bound participant; absolute paths never cross this interface. */
export interface WorkspaceExcludeParticipant {
  ensure(input?: { directChildMounts?: readonly string[] }): Promise<WorkspaceExcludeProfileReceipt>
}

/** Bound candidate/index/commit surface; no repository path crosses it. */
export interface RepositoryCommitCandidateParticipant {
  prepare(): Promise<PrepareRepositoryCommitResult>
  preview(): Promise<RepositoryCommitPreviewResult>
  commitPrepared(input: {
    message: string
    verification: 'normal' | 'artifact'
    authorName?: string | null
    authorEmail?: string | null
  }): Promise<CommitPreparedResult>
  classifyPath(input: {
    path: string
    directory?: boolean
  }): Promise<{ excluded: boolean; policyDigest: string }>
}

/** Bound ref/publication surface; every publish performs its own history scan. */
export interface RepositoryCommitPublicationParticipant {
  publish(input: {
    baseSha: string
    tipSha: string
    mode: RepositoryPublishMode
  }): Promise<RepositoryPublishResult>
  resolvePushBase(input: {
    remote: string
    branch: string
    fallbackRef: string
  }): Promise<string | null>
  updateRef(input: {
    ref: string
    commitSha?: string
  }): Promise<{ ok: true } | { ok: false; error: string }>
}
