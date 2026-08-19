import { canonicalDigest } from '../domain/canonicalJson'
import type { MissionStatus } from '../domain/mission'
import {
  childCompletionSatisfied,
  type ChildMissionIntent,
  type ChildMissionReceipt,
} from '../domain/stepSaga'
import { launchMission, type LaunchDeps } from '../application/commands/launchMission'
import type { MissionStore } from '../application/ports/missionStore'
import type { RequirementMaterializer } from './requirementMaterializer'

type ObservedChildStatus = ChildMissionReceipt['observedStatus']

function observedStatus(status: MissionStatus): ObservedChildStatus {
  if (status === 'admitting' || status === 'working' || status === 'publishing') return 'running'
  return status
}

function observedAt(now: number): string {
  return new Date(now).toISOString().replace('Z', '+00:00')
}

function receipt(
  store: MissionStore,
  missionId: string,
  completion: ChildMissionIntent['completion'],
  intentDigest: string,
  now: number,
): ChildMissionReceipt {
  const row = store.getMission(missionId)
  if (row === null) throw new Error(`child mission disappeared: ${missionId}`)
  const status = observedStatus(row.status)
  return {
    intentDigest,
    childMissionRef: row.id,
    childRevision: row.revision,
    observedStatus: status,
    completionSatisfied: childCompletionSatisfied(completion, status),
    outputEnvelopeRef:
      row.mrClaimId !== null
        ? `mission-mr:${row.id}:${row.mrClaimId}`
        : row.terminalKind === null
          ? null
          : `mission-terminal:${row.id}:${row.terminalKind}`,
    observedAt: observedAt(now),
  }
}

/** Same bounded-context participant: standard admission + materialization, no row insertion shortcut. */
export function createChildMissionParticipant(deps: {
  readonly launch: LaunchDeps
  readonly store: MissionStore
  readonly materializer: RequirementMaterializer
  readonly drive: (missionId: string) => Promise<unknown>
  readonly now: () => number
}): {
  createOrAdopt(input: ChildMissionIntent): Promise<ChildMissionReceipt>
  observe(input: {
    readonly childMissionRef: string
    readonly completion: ChildMissionIntent['completion']
    readonly intentDigest: string
  }): Promise<ChildMissionReceipt>
} {
  return {
    async createOrAdopt(input) {
      if (input.ancestry.length >= 8) throw new Error('child-mission-depth-exhausted')
      if (new Set(input.ancestry).size !== input.ancestry.length) {
        throw new Error('child-mission-ancestry-cycle')
      }
      const parentMissionId = input.parentMissionRef.split('@')[0]
      if (input.ancestry.at(-1) !== parentMissionId) {
        throw new Error('child-mission-ancestry-parent-mismatch')
      }
      for (const ancestorId of input.ancestry) {
        const ancestor = deps.store.getMission(ancestorId)
        if (ancestor?.employeeId === input.targetEmployeeRef.id) {
          throw new Error('child-mission-employee-cycle')
        }
      }
      const intentDigest = canonicalDigest(input)
      const launched = await launchMission(deps.launch, {
        idempotencyKey: input.idempotencyKey,
        repositoryId: input.targetRepositoryRef,
        repositoryGroupId: null,
        submission: {
          kind: 'direct',
          title: `Delegated work from ${input.parentMissionRef}`,
          body: `Use the frozen parent input envelope ${input.inputEnvelopeRef}.`,
          uploads: [],
        },
        delivery: { kind: 'create-merge-request' },
        requestedEmployee: input.targetEmployeeRef,
        requestedPolicy: null,
        actorUserId: null,
      })
      const stashed = await deps.materializer.stashDirectSubmission({
        missionId: launched.missionId,
        submission: {
          title: `Delegated work from ${input.parentMissionRef}`,
          body: `Use the frozen parent input envelope ${input.inputEnvelopeRef}.`,
          uploads: [],
        },
      })
      if (!stashed.ok) throw new Error(`child-requirement-stash:${stashed.failure.code}`)
      // Return after admission so the parent link can persist the child id
      // before that child is allowed to invoke another employee. The normal
      // mission worker (and subsequent observe calls) drives it from here.
      return receipt(deps.store, launched.missionId, input.completion, intentDigest, deps.now())
    },
    async observe(input) {
      await deps.drive(input.childMissionRef)
      return receipt(
        deps.store,
        input.childMissionRef,
        input.completion,
        input.intentDigest,
        deps.now(),
      )
    },
  }
}
