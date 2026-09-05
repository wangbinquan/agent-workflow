import type { Actor } from '../../src/auth/actor'
import type { DbClient } from '../../src/db/client'
import { composeIdentityAccess } from '../../src/modules/identity-access/composition'
import type { MemoryResourceScopeAccessParticipant } from '../../src/modules/memory/application/ports/resourceScopeAccess'
import type { MemoryScopeAuthority } from '../../src/modules/memory/public/catalog'
import { composeResourceScopeAccessParticipant } from '../../src/modules/resource-catalog/composition/resourceScopeAuthorization'
import type { DatabaseTransaction } from '../../src/platform/persistence/databaseTransaction'

/** 生产同一份装配：resource-catalog 的 scope 访问 participant（RFC-359 W4-D4 起两个 provider 同一份）。 */
export const TEST_RESOURCE_SCOPE_AUTHORIZATION: MemoryResourceScopeAccessParticipant<DatabaseTransaction> =
  composeResourceScopeAccessParticipant()

/**
 * Test-only exact pair. The fixture runtime mints an opaque local authority;
 * tests may choose the legacy actor projection they are characterizing, but
 * they never cast or serialize the authority handle.
 */
export function resourceScopeAuthority(db: DbClient, actor: Actor): MemoryScopeAuthority {
  const identityAccess = composeIdentityAccess(db)
  const context = identityAccess.contexts.fromAuthenticatedPrincipal(
    { userId: actor.user.id, source: actor.source },
    'http',
  )
  return Object.freeze({ authority: context.authority, actor })
}
