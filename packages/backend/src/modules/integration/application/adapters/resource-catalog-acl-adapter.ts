import type {
  DevelopmentAdapterAclIdentityPersistence,
  DevelopmentAdapterStore,
} from '../developmentAdapterCommands'

/** integration 交给 resource-catalog 的 development_adapter identity 面（两个 provider 同一份）。 */
export type DevelopmentAdapterResourceAclIdentityProvider = DevelopmentAdapterAclIdentityPersistence

export function createDevelopmentAdapterResourceCatalogAclAdapter(
  store: Pick<DevelopmentAdapterStore, 'resourceAclIdentity'>,
): DevelopmentAdapterResourceAclIdentityProvider {
  const provider: DevelopmentAdapterResourceAclIdentityProvider = {
    type: 'development_adapter',
    getRevision: (resourceId) => store.resourceAclIdentity.getRevision(resourceId),
    loadForMutation: (transaction, resourceId) =>
      store.resourceAclIdentity.loadForMutation(transaction, resourceId),
  }
  return Object.freeze(provider)
}
