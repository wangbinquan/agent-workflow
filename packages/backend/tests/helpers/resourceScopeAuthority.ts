import type { Actor } from '../../src/auth/actor'
import type { DbClient } from '../../src/db/client'
import { composeIdentityAccess } from '../../src/modules/identity-access/composition'
import { composeResourceScopeAuthorizationBinding } from '../../src/modules/resource-catalog/composition/resourceAcl'
import type {
  MemoryResourceScopeAuthority,
  MemoryResourceScopeAuthorization,
} from '../../src/services/memory'

export const TEST_RESOURCE_SCOPE_AUTHORIZATION: MemoryResourceScopeAuthorization =
  composeResourceScopeAuthorizationBinding()

/**
 * Test-only exact pair. The fixture runtime mints an opaque local authority;
 * tests may choose the legacy actor projection they are characterizing, but
 * they never cast or serialize the authority handle.
 */
export function resourceScopeAuthority(db: DbClient, actor: Actor): MemoryResourceScopeAuthority {
  const identityAccess = composeIdentityAccess(db)
  const context = identityAccess.contexts.fromAuthenticatedPrincipal(
    { userId: actor.user.id, source: actor.source },
    'http',
  )
  return Object.freeze({
    authority: context.authority,
    actor,
    authorization: TEST_RESOURCE_SCOPE_AUTHORIZATION,
  })
}
