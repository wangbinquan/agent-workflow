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
