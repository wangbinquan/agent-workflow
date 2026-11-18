import type { Actor } from '@/auth/actor'
import type { DirectAuthenticatedAuthority } from '@/modules/identity-access/public/participants'
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
} from '../ports/intentContextResourceAuthorization'

export interface IntentContextCurrentAuthorityResolver {
  resolve(authority: ResourceRequestContext): Actor
}

export interface IntentContextResourceAuthorityPair {
  readonly authority: ResourceRequestContext
  readonly actor: DirectAuthenticatedAuthority
}

/**
 * RFC-504 (RFC-294 S10 step 11): the exact-authority resolver, moved here unchanged from composition/intentContextAuthorization.ts
 * (where it was the private currentAuthorityResolver): every read must present the very authority this session was minted for.
 */
export function createIntentContextCurrentAuthorityResolver(
  pair: IntentContextResourceAuthorityPair,
) {
  return Object.freeze({
    resolve(authority: ResourceRequestContext): DirectAuthenticatedAuthority {
      if (authority !== pair.authority) {
        throw new Error('foreign-intent-context-resource-authority')
      }
      return pair.actor
    },
  })
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
