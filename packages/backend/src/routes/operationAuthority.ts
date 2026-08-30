// RFC-344 — trusted current-user authority projection for operation bindings.

import type { Actor } from '@/auth/actor'
import type {
  DirectAuthenticatedAuthority,
  DirectAuthenticatedAuthorityFactory,
} from '@/modules/identity-access/public/participants'

/**
 * Authentication has already resolved and narrowed the Actor at the transport
 * edge. The identity-access factory brands a frozen snapshot before an
 * application descriptor can observe it.
 */
export function directOperationAuthority(
  factory: DirectAuthenticatedAuthorityFactory,
  actor: Actor,
): DirectAuthenticatedAuthority {
  return factory.authorityFromAuthenticatedPrincipal({
    user: Object.freeze({ ...actor.user }),
    source: actor.source,
    permissions: actor.permissions,
    ...(actor.purpose === undefined ? {} : { purpose: actor.purpose }),
    ...(actor.patId === undefined ? {} : { patId: actor.patId }),
    ...(actor.authorityRevision === undefined
      ? {}
      : { authorityRevision: actor.authorityRevision }),
  })
}

/**
 * The MCP purpose gate has already selected the transport door. Mint the same
 * trusted authority snapshot without carrying that door-selection flag into
 * the shared route gate; account permissions and token identity remain exact.
 */
export function directMcpOperationAuthority(
  factory: DirectAuthenticatedAuthorityFactory,
  actor: Actor,
): DirectAuthenticatedAuthority {
  return factory.authorityFromAuthenticatedPrincipal({
    user: Object.freeze({ ...actor.user }),
    source: actor.source,
    permissions: actor.permissions,
    ...(actor.patId === undefined ? {} : { patId: actor.patId }),
    ...(actor.authorityRevision === undefined
      ? {}
      : { authorityRevision: actor.authorityRevision }),
  })
}
