// Bootstrap/provider-adapter entrypoint for resource-catalog-owned required SPI.
// Implementations remain outside the public offered surface.

export type {
  ForeignResourceAclType,
  ResourceAclIdentityMutation,
  ResourceAclIdentityMutationRow,
  ResourceAclIdentityPersistence,
} from '../application/ports/resourceAclPersistence'
