import type { Actor } from '../../src/auth/actor'
import type { ProviderNeutralDatabase } from '../../src/db/query'
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
// RFC-359：函数体把 db 直接转手给收 `ProviderNeutralDatabase` 的 `composeIdentityAccess`，
// 入参写 `DbClient` 是纯类型债——它把这个夹具挡在双引擎用例之外。
export function resourceScopeAuthority(
  db: ProviderNeutralDatabase,
  actor: Actor,
): MemoryScopeAuthority {
  const identityAccess = composeIdentityAccess(db)
  const context = identityAccess.contexts.fromAuthenticatedPrincipal(
    { userId: actor.user.id, source: actor.source },
    'http',
  )
  return Object.freeze({ authority: context.authority, actor })
}
