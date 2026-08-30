// RFC-344 — trusted current-user authority projection for operation bindings.

import type { Actor } from '@/auth/actor'
import type {
  DirectAuthenticatedAuthority,
  DirectAuthorityBinding,
  DirectRequestAuthority,
} from '@/modules/identity-access/public/participants'

/**
 * Authentication already registered this exact compatibility projection at
 * the credential edge. Resolve the original handle/projection pair by object
 * identity; never copy a plain snapshot at the route.
 */
export function directOperationAuthority(
  factory: DirectAuthorityBinding,
  actor: Actor,
): DirectAuthenticatedAuthority {
  return factory.legacyProjectionForAuthority(factory.authorityForLegacyProjection(actor))
}

export function directRequestAuthority(
  factory: DirectAuthorityBinding,
  actor: Actor,
): DirectRequestAuthority {
  return factory.authorityForLegacyProjection(actor)
}

/**
 * The MCP purpose gate has already selected the transport door. Mint the same
 * trusted authority snapshot without carrying that door-selection flag into
 * the shared route gate; account permissions and token identity remain exact.
 */
export function directMcpOperationAuthority(
  factory: DirectAuthorityBinding,
  actor: Actor,
): DirectAuthenticatedAuthority {
  return directOperationAuthority(factory, actor)
}
