// RFC-551 (RFC-294 S9): the bound candidate and publication participants a workspace change publication drives. They sat on `public/` without any other module consuming them.
import type {
  CommitPreparedResult,
  PrepareRepositoryCommitResult,
  RepositoryCommitPreviewResult,
} from '../../public/types'

/** Bound candidate/index/commit surface; no repository path crosses it. */
export interface RepositoryCommitCandidateParticipant {
  prepare(): Promise<PrepareRepositoryCommitResult>
  preview(): Promise<RepositoryCommitPreviewResult>
  commitPrepared(input: {
    message: string
    verification: 'normal' | 'artifact'
    authorName?: string | null
    authorEmail?: string | null
    /** `prepare`'s tree; restores the index a sibling merge-back reset meanwhile. */
    preparedTree?: string
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

export type RepositoryPublishMode =
  | {
      readonly kind: 'normal'
      readonly remote: string
      readonly branch: string
      readonly leadingArgs?: readonly string[]
    }
  | {
      readonly kind: 'cas'
      readonly remote: string
      readonly branch: string
      readonly expectedRemoteSha: string
    }
  | { readonly kind: 'new'; readonly remote: string; readonly branch: string }

export type RepositoryPublishResult =
  | { ok: true; policyDigest: string }
  | {
      ok: false
      reason: 'excluded-history'
      policyDigest: string
      excludedPaths: readonly string[]
    }
  | { ok: false; reason: 'failed'; error: string }
