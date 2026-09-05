// RFC-359 W4-D1 —— 集成触发器的资源快照加载：一份实现，两个 provider 共用。
// Integration owns the transaction and the Digital Employee participant; Resource
// Catalog owns classic-resource ACL/content reads. Both are bound to the same
// transaction handle before any snapshot is loaded.

import type { ProviderNeutralDatabase } from '@/db/query'
import { createDigitalEmployeeIntegrationTriggerParticipantIn } from '@/modules/digital-employee/composition'
import type { IntegrationTriggerResourceSnapshotFactory } from '@/modules/resource-catalog/composition/integrationTrigger'
import type {
  FrozenIntegrationTriggerResourceSnapshot,
  IntegrationTriggerResourceRequest,
} from '@/modules/resource-catalog/public/types'
import {
  databaseSessionFor,
  type DatabaseTransaction,
} from '@/platform/persistence/databaseTransaction'
import type {
  IntegrationTriggerAuthorityPair,
  IntegrationTriggerResourceQueries,
} from '../application/ports/scheduledTaskPersistence'
import type { IntegrationTriggerTransactionLoader } from './scheduledTaskPersistence'

export type IntegrationTriggerResources = IntegrationTriggerResourceQueries &
  IntegrationTriggerTransactionLoader

export function createIntegrationTriggerResources(
  db: ProviderNeutralDatabase,
  factory: IntegrationTriggerResourceSnapshotFactory,
): IntegrationTriggerResources {
  const loadInTransaction: IntegrationTriggerTransactionLoader['loadAuthorized'] = async (
    transaction,
    pair,
    requests,
  ) => {
    const participant = factory.inTransaction(
      transaction,
      pair,
      createDigitalEmployeeIntegrationTriggerParticipantIn(transaction),
    )
    return await participant.loadAuthorized(pair.authority, requests)
  }

  function loadAuthorized(
    pair: IntegrationTriggerAuthorityPair,
    requests: readonly IntegrationTriggerResourceRequest[],
  ): Promise<readonly FrozenIntegrationTriggerResourceSnapshot[]>
  function loadAuthorized(
    transaction: DatabaseTransaction,
    pair: IntegrationTriggerAuthorityPair,
    requests: readonly IntegrationTriggerResourceRequest[],
  ): Promise<readonly FrozenIntegrationTriggerResourceSnapshot[]>
  async function loadAuthorized(
    first: DatabaseTransaction | IntegrationTriggerAuthorityPair,
    second: IntegrationTriggerAuthorityPair | readonly IntegrationTriggerResourceRequest[],
    third?: readonly IntegrationTriggerResourceRequest[],
  ): Promise<readonly FrozenIntegrationTriggerResourceSnapshot[]> {
    if (third !== undefined) {
      return await loadInTransaction(
        first as DatabaseTransaction,
        second as IntegrationTriggerAuthorityPair,
        third,
      )
    }
    return await databaseSessionFor(db).transaction(
      async (transaction) =>
        await loadInTransaction(
          transaction,
          first as IntegrationTriggerAuthorityPair,
          second as readonly IntegrationTriggerResourceRequest[],
        ),
    )
  }

  return Object.freeze({ loadAuthorized }) as IntegrationTriggerResources
}
