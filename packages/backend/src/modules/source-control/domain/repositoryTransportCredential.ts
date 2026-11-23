// RFC-321 — credential precedence is a pure domain decision. Only absence may
// fall through; stale or unusable selected credentials are explicit failures.

import type { CodeHostProvider } from '@agent-workflow/shared'

export interface RepositoryTransportBinding {
  readonly provider: CodeHostProvider
  readonly connectionGeneration: string
  readonly endpointBindingDigest: string
}

export interface RepositoryTransportCredentialCandidate {
  readonly credentialRef: string
  readonly connectionGeneration: string
  readonly endpointBindingDigest: string
  readonly credentialRevision: number
}

export function selectRepositoryTransportCredential(input: {
  readonly subjectKind: 'user' | 'system'
  readonly binding: RepositoryTransportBinding | null
  readonly personal: RepositoryTransportCredentialCandidate | null
  readonly global: RepositoryTransportCredentialCandidate | null
}): RepositoryTransportCredentialSelection {
  if (input.binding === null) {
    return { ok: true, source: 'legacy', credentialRevision: null }
  }
  if (input.subjectKind === 'user' && input.personal !== null) {
    if (
      input.personal.connectionGeneration !== input.binding.connectionGeneration ||
      input.personal.endpointBindingDigest !== input.binding.endpointBindingDigest
    ) {
      return { ok: false, code: 'code-host-push-credential-stale' }
    }
    return {
      ok: true,
      source: 'personal',
      credentialRef: input.personal.credentialRef,
      credentialRevision: input.personal.credentialRevision,
    }
  }
  if (input.global !== null) {
    if (
      input.global.connectionGeneration !== input.binding.connectionGeneration ||
      input.global.endpointBindingDigest !== input.binding.endpointBindingDigest
    ) {
      return { ok: false, code: 'code-host-push-credential-stale' }
    }
    return {
      ok: true,
      source: 'global',
      credentialRef: input.global.credentialRef,
      credentialRevision: input.global.credentialRevision,
    }
  }
  return { ok: true, source: 'legacy', credentialRevision: null }
}

// RFC-551 (RFC-294 S9): moved from `public/types` (no other module read it); the credential selection port returns it.
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
