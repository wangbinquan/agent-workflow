import type { Actor } from '@/auth/actor'
import type { ResourceGrantLevel } from '@agent-workflow/shared'
import {
  canViewAccess,
  resolveAccessFrom,
  resourceAclAudienceAuthority,
} from '../../domain/resourceAccess'
import { intentContextResourceAuthorizationSessionBrand } from '../../domain/participantBrands'
import type {
  IntentContextResourceAuthorizationSession,
  IntentContextResourceIdentity,
  IntentContextResourceReference,
  ResourceRequestContext,
} from '../../public/participants'
import type {
  IntentContextResourceAuthorizationReadPort,
  IntentContextResourceAuthorizationRow,
  IntentContextResourceAuthorizationSyncReadPort,
} from '../ports/intentContextResourceAuthorization'

export interface IntentContextCurrentAuthorityResolver {
  resolve(authority: ResourceRequestContext): Actor
}

/** Provider-private synchronous capability for a SQLite owning tx body. */
export interface IntentContextResourceAuthorizationSyncSession {
  loadVisibleSync(
    authority: ResourceRequestContext,
    reference: IntentContextResourceReference,
  ): IntentContextResourceIdentity | null
}

function projectVisibleIdentity(
  actor: Actor,
  row: IntentContextResourceAuthorizationRow,
  grant: ResourceGrantLevel | null,
): IntentContextResourceIdentity | null {
  const access = resolveAccessFrom(resourceAclAudienceAuthority(actor), actor.user.id, row, grant)
  if (!canViewAccess(access)) return null

  return Object.freeze({
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    name: row.name,
  })
}

/**
 * Mint one exact-authority, transaction-bound Intent context capability.
 * Visibility and an optional expected name are revalidated on every read.
 */
export function createIntentContextResourceAuthorizationSession(
  authorityResolver: IntentContextCurrentAuthorityResolver,
  reads: IntentContextResourceAuthorizationReadPort,
): IntentContextResourceAuthorizationSession {
  const session = Object.freeze<IntentContextResourceAuthorizationSession>({
    [intentContextResourceAuthorizationSessionBrand]:
      'intent-context-resource-authorization-session',
    async loadVisible(
      authority: ResourceRequestContext,
      reference: IntentContextResourceReference,
    ): Promise<IntentContextResourceIdentity | null> {
      const actor = authorityResolver.resolve(authority)
      const row = await reads.loadIdentity(reference.resourceType, reference.resourceId)
      if (row === null) return null
      if (reference.expectedName !== undefined && row.name !== reference.expectedName) return null

      const audience = resourceAclAudienceAuthority(actor)
      const grant =
        audience.bypass || !audience.private
          ? null
          : await reads.loadGrantLevel(reference.resourceType, reference.resourceId, actor.user.id)
      return projectVisibleIdentity(actor, row, grant)
    },
  })
  return session
}

/**
 * Mint the SQLite-only synchronous variant for use inside dbTxSync.
 * It deliberately stays outside the public participant surface.
 */
export function createIntentContextResourceAuthorizationSyncSession(
  authorityResolver: IntentContextCurrentAuthorityResolver,
  reads: IntentContextResourceAuthorizationSyncReadPort,
): IntentContextResourceAuthorizationSyncSession {
  return Object.freeze<IntentContextResourceAuthorizationSyncSession>({
    loadVisibleSync(authority, reference) {
      const actor = authorityResolver.resolve(authority)
      const row = reads.loadIdentity(reference.resourceType, reference.resourceId)
      if (row === null) return null
      if (reference.expectedName !== undefined && row.name !== reference.expectedName) return null

      const audience = resourceAclAudienceAuthority(actor)
      const grant =
        audience.bypass || !audience.private
          ? null
          : reads.loadGrantLevel(reference.resourceType, reference.resourceId, actor.user.id)
      return projectVisibleIdentity(actor, row, grant)
    },
  })
}
