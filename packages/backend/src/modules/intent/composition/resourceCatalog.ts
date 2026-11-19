// RFC-384: bind the session's resource queries and actor contexts in one place.
import type { Actor } from '@/auth/actor'
import type {
  DirectAuthorityBinding,
  DirectQueryContextFactory,
  QueryContext,
} from '@/modules/identity-access/public/participants'
import type { ResourceCatalogQuery } from '@/modules/resource-catalog/public/queries'
import { directOperationAuthority, directRequestAuthority } from '@/routes/operationAuthority'
import {
  composeIntentResourceCatalogFor,
  createIntentCatalogActorBinding,
  type IntentResourceCatalogFactoryDependencies,
} from '../application/resourceCatalog'

export function composeIntentResourceCatalogBinding(input: {
  readonly resourceCatalog: {
    createQuery(input: {
      readonly resolveActor: (context: QueryContext) => Actor
    }): ResourceCatalogQuery
  }
  readonly identityAccess: {
    readonly contexts: DirectQueryContextFactory
    readonly directAuthority: DirectAuthorityBinding
  }
  readonly catalogs: IntentResourceCatalogFactoryDependencies['catalogs']
}) {
  const { identityAccess } = input
  // RFC-506: the per-request actor binding lives in application; this file only wires it.
  const actors = createIntentCatalogActorBinding()
  return composeIntentResourceCatalogFor({
    query: input.resourceCatalog.createQuery({ resolveActor: actors.resolveActor }),
    contextFor(actor) {
      const context = identityAccess.contexts.queryFromAuthority(
        directRequestAuthority(identityAccess.directAuthority, actor),
        'http',
      )
      actors.bind(context, actor)
      return context
    },
    authorityFor: (actor) => directOperationAuthority(identityAccess.directAuthority, actor),
    catalogs: input.catalogs,
  })
}
