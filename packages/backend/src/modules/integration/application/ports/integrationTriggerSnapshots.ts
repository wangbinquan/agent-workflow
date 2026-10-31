import type { PersistenceTx } from '@/platform/persistence/persistenceDb'
import type { IntegrationTriggerAuthorityPair } from './scheduledTaskPersistence'
import type { ResourceRequestContext } from '@/modules/resource-catalog/public/participants'
import type {
  FrozenIntegrationTriggerResourceSnapshot,
  IntegrationTriggerResourceRequest,
} from '@/modules/resource-catalog/public/types'

export interface IntegrationTriggerSnapshotFactory {
  inTransaction(
    tx: PersistenceTx,
    pair: IntegrationTriggerAuthorityPair,
  ): {
    loadAuthorized(
      authority: ResourceRequestContext,
      requests: readonly IntegrationTriggerResourceRequest[],
    ): Promise<readonly FrozenIntegrationTriggerResourceSnapshot[]>
  }
}
