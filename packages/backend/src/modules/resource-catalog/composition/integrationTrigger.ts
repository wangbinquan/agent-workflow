// RFC-345 T4c — bootstrap binding for integration-trigger resource snapshots.

import type { Actor } from '@/auth/actor'
import type { DbTxSync } from '@/db/txSync'
import type { DigitalEmployeeIntegrationTriggerParticipant } from '@/modules/digital-employee/public/participants'
import { createIntegrationTriggerResourceSnapshotInTx } from '../application/participants/integrationTriggerResourceSnapshot'
import {
  createLegacyIntegrationTriggerResourceSnapshotPorts,
  type LegacyIntegrationTriggerResourceDependencies,
} from '../infrastructure/aggregateAdapters/legacyIntegrationTriggerResourceSnapshots'
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

export function composeIntegrationTriggerResourceBinding(
  dependencies: LegacyIntegrationTriggerResourceDependencies,
  digitalEmployeesInTx: (tx: DbTxSync) => DigitalEmployeeIntegrationTriggerParticipant,
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
