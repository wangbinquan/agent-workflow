// RFC-345 T4c —— 数字员工作为集成触发器资源快照的 owner 参与者，绑定到调用方的事务句柄。
// RFC-359 W4-D1：一份实现，两个 provider 共用；SQLite 侧不再有 dbTxSync 的同步参与者。

import { and, eq } from 'drizzle-orm'

import { employeeDefinitionRevisions, employeeDefinitions, employeeTypePackages } from '@/db/schema'
import type { DatabaseTransaction } from '@/platform/persistence/databaseTransaction'
import { createDigitalEmployeeIntegrationTriggerParticipant } from '../application/adapters/integration-trigger-resource-adapter'

/** Transaction-bound owner participant for T4c target freezing（两个引擎同一份）。 */
export function createDigitalEmployeeIntegrationTriggerParticipantIn(tx: DatabaseTransaction) {
  return createDigitalEmployeeIntegrationTriggerParticipant({
    async loadIdentity(employeeDefinitionId) {
      return (
        (
          await tx
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
            .limit(1)
        )[0] ?? null
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
            .limit(1)
        )[0]?.contentJson ?? null
      )
    },
    async loadTypePackage({ typeId, typeRevision }) {
      return (
        (
          await tx
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
            .limit(1)
        )[0] ?? null
      )
    },
  })
}
