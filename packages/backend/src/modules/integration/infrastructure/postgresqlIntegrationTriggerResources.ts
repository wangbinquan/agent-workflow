import { createPostgresqlDigitalEmployeeIntegrationTriggerParticipant } from '@/modules/digital-employee/composition'
import type { PostgresqlIntegrationTriggerResourceSnapshotFactory } from '@/modules/resource-catalog/composition/integrationTrigger'
import type {
  FrozenIntegrationTriggerResourceSnapshot,
  IntegrationTriggerResourceRequest,
} from '@/modules/resource-catalog/public/types'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  IntegrationTriggerAuthorityPair,
  IntegrationTriggerResourceQueries,
} from '../application/ports/scheduledTaskPersistence'
import type {
  PostgresqlIntegrationTriggerTransactionLoader,
  PostgresqlScheduledTaskTransaction,
} from './postgresqlScheduledTaskPersistence'

export type PostgresqlIntegrationTriggerResources = IntegrationTriggerResourceQueries &
  PostgresqlIntegrationTriggerTransactionLoader

/**
 * Integration owns the transaction and Digital Employee participant; Resource
 * Catalog owns classic-resource ACL/content reads. Both are bound to the same
 * PostgreSQL transaction before any snapshot is loaded.
 */
export function createPostgresqlIntegrationTriggerResources(
  db: PostgresqlDatabaseClient,
  factory: PostgresqlIntegrationTriggerResourceSnapshotFactory,
): PostgresqlIntegrationTriggerResources {
  const loadInTransaction: PostgresqlIntegrationTriggerTransactionLoader['loadAuthorized'] = async (
    transaction,
    pair,
    requests,
  ) => {
    const participant = factory.inTransaction(
      transaction,
      pair,
      createPostgresqlDigitalEmployeeIntegrationTriggerParticipant(transaction),
    )
    return await participant.loadAuthorized(pair.authority, requests)
  }

  function loadAuthorized(
    pair: IntegrationTriggerAuthorityPair,
    requests: readonly IntegrationTriggerResourceRequest[],
  ): Promise<readonly FrozenIntegrationTriggerResourceSnapshot[]>
  function loadAuthorized(
    transaction: PostgresqlScheduledTaskTransaction,
    pair: IntegrationTriggerAuthorityPair,
    requests: readonly IntegrationTriggerResourceRequest[],
  ): Promise<readonly FrozenIntegrationTriggerResourceSnapshot[]>
  async function loadAuthorized(
    first: PostgresqlScheduledTaskTransaction | IntegrationTriggerAuthorityPair,
    second: IntegrationTriggerAuthorityPair | readonly IntegrationTriggerResourceRequest[],
    third?: readonly IntegrationTriggerResourceRequest[],
  ): Promise<readonly FrozenIntegrationTriggerResourceSnapshot[]> {
    if (third !== undefined) {
      return await loadInTransaction(
        first as PostgresqlScheduledTaskTransaction,
        second as IntegrationTriggerAuthorityPair,
        third,
      )
    }
    return await db.transaction(
      async (transaction) =>
        await loadInTransaction(
          transaction,
          first as IntegrationTriggerAuthorityPair,
          second as readonly IntegrationTriggerResourceRequest[],
        ),
    )
  }

  return Object.freeze({ loadAuthorized }) as PostgresqlIntegrationTriggerResources
}
