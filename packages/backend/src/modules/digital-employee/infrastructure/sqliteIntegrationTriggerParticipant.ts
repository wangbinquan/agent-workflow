import { and, eq } from 'drizzle-orm'

import { employeeDefinitionRevisions, employeeDefinitions, employeeTypePackages } from '@/db/schema'
import type { DbTxSync } from '@/db/txSync'
import {
  createDigitalEmployeeIntegrationTriggerParticipant,
  projectDigitalEmployeeIntegrationTriggerSnapshot,
} from '../application/adapters/integration-trigger-resource-adapter'
import type { DigitalEmployeeIntegrationTriggerIdentity } from '../public/participants'

/**
 * SQLite transaction-bound owner participant.
 *
 * The promise surface is provider-neutral while every query still executes on
 * the caller's one synchronous SQLite transaction snapshot.
 */
export function createSqliteDigitalEmployeeIntegrationTriggerParticipant(tx: DbTxSync) {
  return createDigitalEmployeeIntegrationTriggerParticipant({
    async loadIdentity(employeeDefinitionId) {
      return (
        tx
          .select({
            id: employeeDefinitions.id,
            ownerUserId: employeeDefinitions.ownerUserId,
            visibility: employeeDefinitions.visibility,
            archivedAt: employeeDefinitions.archivedAt,
            currentRevision: employeeDefinitions.currentRevision,
            typeId: employeeDefinitions.typeId,
            typeRevision: employeeDefinitions.typeRevision,
          })
          .from(employeeDefinitions)
          .where(eq(employeeDefinitions.id, employeeDefinitionId))
          .get() ?? null
      )
    },
    async loadDefinitionRevisionJson(employeeDefinitionId, revision) {
      return (
        tx
          .select({ contentJson: employeeDefinitionRevisions.contentJson })
          .from(employeeDefinitionRevisions)
          .where(
            and(
              eq(employeeDefinitionRevisions.employeeId, employeeDefinitionId),
              eq(employeeDefinitionRevisions.revision, revision),
            ),
          )
          .get()?.contentJson ?? null
      )
    },
    async loadTypePackage({ typeId, typeRevision }) {
      return (
        tx
          .select({
            state: employeeTypePackages.state,
            descriptorJson: employeeTypePackages.descriptorJson,
          })
          .from(employeeTypePackages)
          .where(
            and(
              eq(employeeTypePackages.typeId, typeId),
              eq(employeeTypePackages.revision, typeRevision),
            ),
          )
          .get() ?? null
      )
    },
  })
}

/**
 * Provider-private compatibility participant for the existing SQLite
 * `dbTxSync` integration-trigger atomic. It deliberately does not implement
 * the public async participant type.
 */
export function createSqliteDigitalEmployeeIntegrationTriggerParticipantSync(tx: DbTxSync) {
  const loadIdentity = (
    employeeDefinitionId: string,
  ): DigitalEmployeeIntegrationTriggerIdentity | null =>
    tx
      .select({
        id: employeeDefinitions.id,
        ownerUserId: employeeDefinitions.ownerUserId,
        visibility: employeeDefinitions.visibility,
        archivedAt: employeeDefinitions.archivedAt,
        currentRevision: employeeDefinitions.currentRevision,
        typeId: employeeDefinitions.typeId,
        typeRevision: employeeDefinitions.typeRevision,
      })
      .from(employeeDefinitions)
      .where(eq(employeeDefinitions.id, employeeDefinitionId))
      .get() ?? null

  return Object.freeze({
    loadIdentity,
    loadCurrentSnapshot(employeeDefinitionId: string) {
      const identity = loadIdentity(employeeDefinitionId)
      const revisionJson =
        identity?.currentRevision == null
          ? null
          : (tx
              .select({ contentJson: employeeDefinitionRevisions.contentJson })
              .from(employeeDefinitionRevisions)
              .where(
                and(
                  eq(employeeDefinitionRevisions.employeeId, employeeDefinitionId),
                  eq(employeeDefinitionRevisions.revision, identity.currentRevision),
                ),
              )
              .get()?.contentJson ?? null)
      const typePackage =
        identity === null
          ? null
          : (tx
              .select({
                state: employeeTypePackages.state,
                descriptorJson: employeeTypePackages.descriptorJson,
              })
              .from(employeeTypePackages)
              .where(
                and(
                  eq(employeeTypePackages.typeId, identity.typeId),
                  eq(employeeTypePackages.revision, identity.typeRevision),
                ),
              )
              .get() ?? null)
      return projectDigitalEmployeeIntegrationTriggerSnapshot({
        employeeDefinitionId,
        identity,
        revisionJson,
        typePackage,
      })
    },
  })
}
