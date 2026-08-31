import type { Actor } from '../../src/auth/actor'
import type { DbClient } from '../../src/db/client'
import { composeIdentityAccess } from '../../src/modules/identity-access/composition'
import { composeIntentApplyResourceBinding } from '../../src/modules/resource-catalog/composition/intentApply'
import { legacyIntentApplyResourceDependencies } from '../../src/services/intent/legacyIntentApplyResourceDependencies'

/** Test-only composition of the same exact authority/resource pair used by the HTTP bootstrap. */
export function intentApplyResourceBinding(db: DbClient, actor: Actor) {
  const identityAccess = composeIdentityAccess(db)
  const context = identityAccess.contexts.fromAuthenticatedPrincipal(
    { userId: actor.user.id, source: actor.source },
    'http',
  )
  return Object.freeze({
    authority: context.authority,
    resourceApply: composeIntentApplyResourceBinding(legacyIntentApplyResourceDependencies),
  })
}
