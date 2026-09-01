import { and, eq } from 'drizzle-orm'

import { employeeDefinitionRevisions, employeeDefinitions, employeeTypePackages } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { createDigitalEmployeeIntegrationTriggerParticipant } from '../application/adapters/integration-trigger-resource-adapter'

export type DigitalEmployeePostgresqlTransaction = Parameters<
  Parameters<PostgresqlDatabaseClient['transaction']>[0]
>[0]

/** PostgreSQL transaction-bound owner participant for T4c target freezing. */
export function createPostgresqlDigitalEmployeeIntegrationTriggerParticipant(
  tx: DigitalEmployeePostgresqlTransaction,
) {
  return createDigitalEmployeeIntegrationTriggerParticipant({
    async loadIdentity(employeeDefinitionId) {
      return (
        (await tx
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
          .get()) ?? null
      )
    },
    async loadDefinitionRevisionJson(employeeDefinitionId, revision) {
      return (
        (
          await tx
            .select({ contentJson: employeeDefinitionRevisions.contentJson })
            .from(employeeDefinitionRevisions)
            .where(
              and(
                eq(employeeDefinitionRevisions.employeeId, employeeDefinitionId),
                eq(employeeDefinitionRevisions.revision, revision),
              ),
            )
            .get()
        )?.contentJson ?? null
      )
    },
    async loadTypePackage({ typeId, typeRevision }) {
      return (
        (await tx
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
          .get()) ?? null
      )
    },
  })
}
