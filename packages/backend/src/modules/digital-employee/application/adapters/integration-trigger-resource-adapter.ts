import { z } from 'zod'

import type {
  DigitalEmployeeIntegrationTriggerIdentity,
  DigitalEmployeeIntegrationTriggerParticipant,
  DigitalEmployeeIntegrationTriggerSnapshot,
} from '../../public/participants'

export interface DigitalEmployeeIntegrationTriggerPersistence {
  loadIdentity(
    employeeDefinitionId: string,
  ): Promise<DigitalEmployeeIntegrationTriggerIdentity | null>
  loadDefinitionRevisionJson(employeeDefinitionId: string, revision: number): Promise<string | null>
  loadTypePackage(input: {
    readonly typeId: string
    readonly typeRevision: number
  }): Promise<Readonly<{ readonly state: string; readonly descriptorJson: string }> | null>
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

/** Provider-independent projection shared by async live and SQLite compatibility adapters. */
export function projectDigitalEmployeeIntegrationTriggerSnapshot(input: {
  readonly employeeDefinitionId: string
  readonly identity: DigitalEmployeeIntegrationTriggerIdentity | null
  readonly revisionJson: string | null
  readonly typePackage: Readonly<{ readonly state: string; readonly descriptorJson: string }> | null
}): DigitalEmployeeIntegrationTriggerSnapshot {
  if (input.identity === null || input.identity.currentRevision === null) {
    return Object.freeze({ kind: 'revision-unavailable' as const })
  }
  if (input.revisionJson === null || jsonObject(input.revisionJson) === null) {
    return Object.freeze({ kind: 'revision-unavailable' as const })
  }
  if (input.typePackage === null || input.typePackage.state !== 'published') {
    return Object.freeze({ kind: 'intake-unavailable' as const })
  }
  const contract = intakeContractSchema.safeParse(jsonObject(input.typePackage.descriptorJson))
  if (!contract.success) {
    return Object.freeze({ kind: 'intake-unavailable' as const })
  }
  return Object.freeze({
    kind: 'ready' as const,
    employeeDefinitionId: input.employeeDefinitionId,
    currentRevision: input.identity.currentRevision,
    typeId: input.identity.typeId,
    typeRevision: input.identity.typeRevision,
    intake: Object.freeze({
      acceptedKinds: Object.freeze([...contract.data.workIntakeAuthoring.acceptedKinds]),
      targetFields: Object.freeze(
        contract.data.workIntakeAuthoring.targetFields.map((field) =>
          Object.freeze({ fieldRef: field.fieldRef, required: field.required }),
        ),
      ),
    }),
  })
}

const trustedIntegrationTriggerParticipants =
  new WeakSet<DigitalEmployeeIntegrationTriggerParticipant>()

export function createDigitalEmployeeIntegrationTriggerParticipant(
  persistence: DigitalEmployeeIntegrationTriggerPersistence,
): DigitalEmployeeIntegrationTriggerParticipant {
  const participant = Object.freeze({
    async loadIdentity(employeeDefinitionId: string) {
      const identity = await persistence.loadIdentity(employeeDefinitionId)
      return identity === null ? null : Object.freeze({ ...identity })
    },

    async loadCurrentSnapshot(employeeDefinitionId: string) {
      const identity = await persistence.loadIdentity(employeeDefinitionId)
      const revisionJson =
        identity?.currentRevision == null
          ? null
          : await persistence.loadDefinitionRevisionJson(
              employeeDefinitionId,
              identity.currentRevision,
            )
      const typePackage =
        identity === null
          ? null
          : await persistence.loadTypePackage({
              typeId: identity.typeId,
              typeRevision: identity.typeRevision,
            })
      return projectDigitalEmployeeIntegrationTriggerSnapshot({
        employeeDefinitionId,
        identity,
        revisionJson,
        typePackage,
      })
    },
  }) as unknown as DigitalEmployeeIntegrationTriggerParticipant
  trustedIntegrationTriggerParticipants.add(participant)
  return participant
}
