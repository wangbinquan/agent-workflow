import { z } from 'zod'

import type { DigitalEmployeeIntegrationTriggerParticipant } from '../../public/participants'

interface DigitalEmployeeIntegrationTriggerPersistence {
  loadIdentity(employeeDefinitionId: string): Readonly<{
    readonly id: string
    readonly ownerUserId: string | null
    readonly visibility: 'private' | 'public'
    readonly archivedAt: number | null
    readonly currentRevision: number | null
    readonly typeId: string
    readonly typeRevision: number
  }> | null
  loadDefinitionRevisionJson(employeeDefinitionId: string, revision: number): string | null
  loadTypePackage(input: {
    readonly typeId: string
    readonly typeRevision: number
  }): Readonly<{ readonly state: string; readonly descriptorJson: string }> | null
}

const intakeContractSchema = z
  .object({
    workIntakeAuthoring: z
      .object({
        acceptedKinds: z.array(z.enum(['body', 'files', 'body-and-files', 'external-id'])),
        targetFields: z.array(
          z.object({ fieldRef: z.string().min(1), required: z.boolean() }).passthrough(),
        ),
      })
      .passthrough(),
  })
  .passthrough()

function jsonObject(raw: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(raw)
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

const trustedIntegrationTriggerParticipants =
  new WeakSet<DigitalEmployeeIntegrationTriggerParticipant>()

export function createDigitalEmployeeIntegrationTriggerParticipant(
  persistence: DigitalEmployeeIntegrationTriggerPersistence,
): DigitalEmployeeIntegrationTriggerParticipant {
  const participant = Object.freeze({
    loadIdentity(employeeDefinitionId: string) {
      const identity = persistence.loadIdentity(employeeDefinitionId)
      return identity === null ? null : Object.freeze({ ...identity })
    },

    loadCurrentSnapshot(employeeDefinitionId: string) {
      const identity = persistence.loadIdentity(employeeDefinitionId)
      if (identity === null || identity.currentRevision === null) {
        return Object.freeze({ kind: 'revision-unavailable' as const })
      }
      const revisionJson = persistence.loadDefinitionRevisionJson(
        employeeDefinitionId,
        identity.currentRevision,
      )
      const revision = revisionJson === null ? null : jsonObject(revisionJson)
      if (revision === null) {
        return Object.freeze({ kind: 'revision-unavailable' as const })
      }
      const typePackage = persistence.loadTypePackage({
        typeId: identity.typeId,
        typeRevision: identity.typeRevision,
      })
      if (typePackage === null || typePackage.state !== 'published') {
        return Object.freeze({ kind: 'intake-unavailable' as const })
      }
      const contract = intakeContractSchema.safeParse(jsonObject(typePackage.descriptorJson))
      if (!contract.success) {
        return Object.freeze({ kind: 'intake-unavailable' as const })
      }
      return Object.freeze({
        kind: 'ready' as const,
        employeeDefinitionId,
        currentRevision: identity.currentRevision,
        typeId: identity.typeId,
        typeRevision: identity.typeRevision,
        intake: Object.freeze({
          acceptedKinds: Object.freeze([...contract.data.workIntakeAuthoring.acceptedKinds]),
          targetFields: Object.freeze(
            contract.data.workIntakeAuthoring.targetFields.map((field) =>
              Object.freeze({ fieldRef: field.fieldRef, required: field.required }),
            ),
          ),
        }),
      })
    },
  }) as unknown as DigitalEmployeeIntegrationTriggerParticipant
  trustedIntegrationTriggerParticipants.add(participant)
  return participant
}
