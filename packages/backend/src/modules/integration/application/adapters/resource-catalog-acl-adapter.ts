import type { ResourceAclIdentityPersistence } from '@/modules/resource-catalog/public/operations'
import type { DevelopmentAdapterStore } from '../developmentAdapterCommands'

export function createDevelopmentAdapterResourceCatalogAclAdapter(
  store: Pick<DevelopmentAdapterStore, 'resourceAclIdentity'>,
): ResourceAclIdentityPersistence {
  return {
    type: 'development_adapter',
    getRevision: (resourceId) => store.resourceAclIdentity.getRevision(resourceId),
    withMutation: (resourceId, run) =>
      store.resourceAclIdentity.withMutation(resourceId, (mutation) =>
        run({
          current: mutation.current,
          ownerNameIsUnique: mutation.ownerNameIsUnique,
          hasOwnerNameCollision: (nextOwnerUserId) =>
            mutation.hasOwnerNameCollision(nextOwnerUserId),
          update: (input) => mutation.update(input),
        }),
      ),
  }
}
