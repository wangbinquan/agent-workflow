import type { Actor } from '../../src/auth/actor'
import type { ProviderNeutralDatabase } from '../../src/db/query'
import { composeIdentityAccess } from '../../src/modules/identity-access/composition'

/**
 * Test-only composition of the same exact authority used by the HTTP bootstrap.
 *
 * RFC-359 —— 此前这里还交出一个 `resourceApply`（legacy SQLite 资源会话）。两台 apply
 * 引擎合一后资源会话由 `composeIntentApplyOperations` 自己按 `db` + `appHome` 装配，
 * 调用方只需要把 authority 递进去。
 */
export function intentApplyResourceBinding(db: ProviderNeutralDatabase, actor: Actor) {
  const identityAccess = composeIdentityAccess(db)
  const context = identityAccess.contexts.fromAuthenticatedPrincipal(
    { userId: actor.user.id, source: actor.source },
    'http',
  )
  return Object.freeze({ authority: context.authority })
}
