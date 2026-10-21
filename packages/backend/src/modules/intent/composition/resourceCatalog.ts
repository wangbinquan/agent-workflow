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
  const intentCatalogActors = new WeakMap<object, Actor>()
  return composeIntentResourceCatalogFor({
    query: input.resourceCatalog.createQuery({
      resolveActor(context) {
        const actor = intentCatalogActors.get(context)
        if (actor === undefined) throw new Error('intent-resource-catalog-context-not-bound')
        return actor
      },
    }),
    contextFor(actor) {
      const context = identityAccess.contexts.queryFromAuthority(
        directRequestAuthority(identityAccess.directAuthority, actor),
        'http',
      )
      intentCatalogActors.set(context, actor)
      return context
    },
    authorityFor: (actor) => directOperationAuthority(identityAccess.directAuthority, actor),
    catalogs: input.catalogs,
  })
}
