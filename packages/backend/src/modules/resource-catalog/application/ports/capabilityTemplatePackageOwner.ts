// RFC-609 (RFC-294 S9): the owner-native arm the PostgreSQL resource package transaction calls for capability templates.
// Capability-template persistence stays with its native aggregate (development automation's capability templates), which
// implements this port; Resource Catalog offers it through `composition/required-ports` so the implementation takes it
// from its designated adapter instead of this module's infrastructure.
import type { PersistenceTx } from '@/platform/persistence/persistenceDb'
import type { ResourceRequestContext } from '../../public/participants'
import type { ResourcePackageArtifactContext } from '../package/artifactOwners'
import type { CapabilityTemplatePackageMutation } from '../package/preparedMutations'

/** Capability-template persistence remains owned by its native aggregate. */
export interface CapabilityTemplatePackageMutationOwner {
  prepareOwnerNative(
    context: ResourcePackageArtifactContext,
    input: Readonly<{
      mutation: CapabilityTemplatePackageMutation
      resourceId: string
    }>,
  ): Promise<unknown>
  commitOwnerNativeInTransaction(
    transaction: PersistenceTx,
    context: ResourcePackageArtifactContext,
    input: Readonly<{
      mutation: CapabilityTemplatePackageMutation
      resourceId: string
      payload: Readonly<Record<string, unknown>>
      prepared: unknown
      ownership: Readonly<{
        authority: ResourceRequestContext
        ownerUserId: string
        visibility: 'private'
        builtin: false
      }>
    }>,
  ): Promise<void>
}
