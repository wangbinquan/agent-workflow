// RFC-345 T4c — bootstrap binding for integration-trigger resource snapshots.

import type { Actor } from '@/auth/actor'
import type { DbTxSync } from '@/db/txSync'
import type { DigitalEmployeeIntegrationTriggerParticipant } from '@/modules/digital-employee/public/participants'
import { createIntegrationTriggerResourceSnapshotInTx } from '../application/participants/integrationTriggerResourceSnapshot'
import {
  createLegacyIntegrationTriggerResourceSnapshotPorts,
  type LegacyDigitalEmployeeIntegrationTriggerParticipant,
  type LegacyIntegrationTriggerResourceDependencies,
} from '../infrastructure/aggregateAdapters/legacyIntegrationTriggerResourceSnapshots'
import {
  createPostgresqlIntegrationTriggerResourceSnapshotReader,
  type PostgresqlIntegrationTriggerResourceDependencies,
  type PostgresqlIntegrationTriggerResourceSnapshotReader,
  type PostgresqlIntegrationTriggerResourceTransaction,
} from '../infrastructure/aggregateAdapters/postgresqlIntegrationTriggerResourceSnapshots'
import type {
  IntegrationTriggerResourceSnapshotInTx,
  ResourceRequestContext,
} from '../public/participants'

export interface IntegrationTriggerResourceAuthorityPair {
  readonly authority: ResourceRequestContext
  readonly actor: Actor
}

export interface IntegrationTriggerResourceBinding {
  inTransaction(
    tx: DbTxSync,
    pair: IntegrationTriggerResourceAuthorityPair,
  ): IntegrationTriggerResourceSnapshotInTx
}

export interface PostgresqlIntegrationTriggerResourceSnapshotFactory {
  inTransaction(
    transaction: PostgresqlIntegrationTriggerResourceTransaction,
    pair: IntegrationTriggerResourceAuthorityPair,
    digitalEmployees: DigitalEmployeeIntegrationTriggerParticipant,
  ): PostgresqlIntegrationTriggerResourceSnapshotReader
}

export function composeIntegrationTriggerResourceBinding(
  dependencies: LegacyIntegrationTriggerResourceDependencies,
  digitalEmployeesInTx: (tx: DbTxSync) => LegacyDigitalEmployeeIntegrationTriggerParticipant,
): IntegrationTriggerResourceBinding {
  return Object.freeze({
    inTransaction(tx: DbTxSync, pair: IntegrationTriggerResourceAuthorityPair) {
      return createIntegrationTriggerResourceSnapshotInTx(
        createLegacyIntegrationTriggerResourceSnapshotPorts(
          {
            tx,
            authority: pair.authority,
            actor: pair.actor,
            digitalEmployees: digitalEmployeesInTx(tx),
          },
          dependencies,
        ),
      )
    },
  })
}

/**
 * PostgreSQL Integration adapter factory. The Integration owner reserves the
 * transaction and supplies its owner-native Digital Employee participant;
 * Resource Catalog binds every ACL and content read to that exact transaction
 * and exact admitted authority pair.
 */
export function composePostgresqlIntegrationTriggerResourceSnapshotFactory(
  dependencies: PostgresqlIntegrationTriggerResourceDependencies,
): PostgresqlIntegrationTriggerResourceSnapshotFactory {
  return Object.freeze({
    inTransaction(
      transaction: PostgresqlIntegrationTriggerResourceTransaction,
      pair: IntegrationTriggerResourceAuthorityPair,
      digitalEmployees: DigitalEmployeeIntegrationTriggerParticipant,
    ) {
      return createPostgresqlIntegrationTriggerResourceSnapshotReader(
        {
          transaction,
          authority: pair.authority,
          actor: pair.actor,
          digitalEmployees,
        },
        dependencies,
      )
    },
  })
}
