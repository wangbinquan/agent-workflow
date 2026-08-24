import type {
  RepositoryCredentialSubject,
  RepositoryPublicationReceipt,
} from '@agent-workflow/shared'

export interface WorkspaceExcludeProfileReceipt {
  version: 1
  digest: string
  directChildMounts: readonly string[]
}

export interface CommitExclusionReceipt {
  readonly policyDigest: string
  readonly excludedPaths: readonly string[]
}

export type PrepareRepositoryCommitResult =
  | { ok: true; receipt: CommitExclusionReceipt }
  | { ok: false; error: string }

export type RepositoryCommitPreviewResult =
  | { ok: true; diff: string; receipt: CommitExclusionReceipt }
  | { ok: false; error: string }

export type CommitPreparedResult =
  | { ok: true; commitSha: string }
  | { ok: false; reason: 'no-changes' }
  | { ok: false; reason: 'failed'; error: string }

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

/**
 * Secret-free result of selecting the credential identity for one managed
 * publication. The opaque ref can only be redeemed inside source-control's
 * infrastructure boundary.
 */
export type RepositoryTransportCredentialSelection =
  | {
      readonly ok: true
      readonly source: 'personal' | 'global'
      readonly credentialRef: string
      readonly credentialRevision: number
    }
  | { readonly ok: true; readonly source: 'legacy'; readonly credentialRevision: null }
  | { readonly ok: false; readonly code: 'code-host-push-credential-stale' }

export type OwnRepositoryCredentialSubject = Extract<
  RepositoryCredentialSubject,
  { readonly kind: 'user' }
>

export type RepositoryTransportCredentialErrorKind = 'validation' | 'conflict' | 'not-found'

export class RepositoryTransportCredentialError extends Error {
  constructor(
    readonly kind: RepositoryTransportCredentialErrorKind,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'RepositoryTransportCredentialError'
  }
}

export type RepositoryPublicationSubject = RepositoryCredentialSubject

export interface RepositoryPublicationGitOptions {
  readonly env?: Record<string, string | undefined>
  readonly stdin?: string
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

export interface RepositoryPublicationGitResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

export type OpenRepositoryPublicationSessionResult =
  | { readonly ok: true; readonly session: RepositoryPublicationSession }
  | {
      readonly ok: false
      readonly code:
        | 'code-host-push-credential-stale'
        | 'code-host-push-credential-unavailable'
        | 'repository-http-endpoint-unresolved'
        | 'repository-http-endpoint-untrusted'
      readonly detail: string
    }

export interface RepositoryPublicationSession {
  readonly endpointUrl: string
  readonly receipt: RepositoryPublicationReceipt
  runNetwork(
    repoPath: string,
    args: readonly string[],
    options?: RepositoryPublicationGitOptions,
  ): Promise<RepositoryPublicationGitResult>
  close(): void
}

export interface RepositoryPublicationTransport {
  open(input: {
    readonly subject: RepositoryPublicationSubject
    readonly remoteUrl: string
  }): Promise<OpenRepositoryPublicationSessionResult>
}
