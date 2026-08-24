// RFC-321 — credential precedence is a pure domain decision. Only absence may
// fall through; stale or unusable selected credentials are explicit failures.

import type { CodeHostProvider } from '@agent-workflow/shared'
import type { RepositoryTransportCredentialSelection } from '../public/types'

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
