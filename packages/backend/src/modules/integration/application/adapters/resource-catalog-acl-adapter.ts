import type {
  DevelopmentAdapterAclIdentityMutation,
  DevelopmentAdapterStore,
} from '../developmentAdapterCommands'

export interface DevelopmentAdapterResourceAclIdentityProvider {
  readonly type: 'development_adapter'
  getRevision(resourceId: string): number
  withMutation<T>(
    resourceId: string,
    run: (mutation: DevelopmentAdapterAclIdentityMutation) => T,
  ): T | undefined
}

export function createDevelopmentAdapterResourceCatalogAclAdapter(
  store: Pick<DevelopmentAdapterStore, 'resourceAclIdentity'>,
): DevelopmentAdapterResourceAclIdentityProvider {
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
