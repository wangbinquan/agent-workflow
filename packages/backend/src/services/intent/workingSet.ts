// RFC-293 — provider-neutral staged working-context changes.

import type { IntentWorkingSetChangeDto, PostIntentWorkingSetChange } from '@agent-workflow/shared'

import type { Actor } from '@/auth/actor'
import {
  applyIntentWorkingSetDelta,
  type AppliedIntentWorkingSetDelta,
} from '@/modules/intent/application/intentWorkingSetDelta'
import type {
  IntentContextResourceAuthorization,
  IntentPersistence,
  IntentWorkingSetChangeRecord,
  ReservedIntentTurnRecord,
} from '@/modules/intent/public/operations'

export { applyIntentWorkingSetDelta }
export type { AppliedIntentWorkingSetDelta }
export type IntentWorkingSetChangeRow = IntentWorkingSetChangeRecord

export interface SubmittedIntentWorkingSetChange {
  change: IntentWorkingSetChangeDto
  reservation: ReservedIntentTurnRecord | null
  shouldInterrupt: boolean
}

export interface DrainedIntentWorkingSetChange {
  change: IntentWorkingSetChangeDto | null
  reservation: ReservedIntentTurnRecord | null
}

export function projectIntentWorkingSetChange(
  row: IntentWorkingSetChangeRecord,
): IntentWorkingSetChangeDto {
  const delta = JSON.parse(row.deltaJson) as IntentWorkingSetChangeDto['delta']
  return {
    id: row.id,
    mode: row.mode,
    state: row.state,
    delta,
    expectedTurnSeq: row.expectedTurnSeq,
    expectedContextRevision: row.expectedContextRevision,
    resultingContextRevision: row.resultingContextRevision,
    resultingTurnId: row.resultingTurnId,
    error: row.error,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export async function getLatestIntentWorkingSetChange(
  persistence: IntentPersistence,
  sessionId: string,
): Promise<IntentWorkingSetChangeRecord | null> {
  return await persistence.latestWorkingSetChange(sessionId)
}

export async function activateIntentWorkingSetChange(
  persistence: IntentPersistence,
  visibility: IntentContextResourceAuthorization,
  actor: Actor,
  sessionId: string,
  maxGenerateRounds: number,
  changeId?: string,
): Promise<DrainedIntentWorkingSetChange> {
  return await persistence.activateWorkingSetChange({
    ownerUserId: actor.user.id,
    sessionId,
    maxGenerateRounds,
    visibility,
    ...(changeId === undefined ? {} : { changeId }),
  })
}

export async function submitIntentWorkingSetChange(
  persistence: IntentPersistence,
  visibility: IntentContextResourceAuthorization,
  actor: Actor,
  sessionId: string,
  input: PostIntentWorkingSetChange,
  maxGenerateRounds: number,
): Promise<SubmittedIntentWorkingSetChange> {
  return await persistence.submitWorkingSetChange({
    ownerUserId: actor.user.id,
    sessionId,
    request: input,
    maxGenerateRounds,
    visibility,
  })
}

export async function cancelIntentWorkingSetChange(
  persistence: IntentPersistence,
  actor: Actor,
  sessionId: string,
  changeId: string,
): Promise<IntentWorkingSetChangeDto> {
  return await persistence.cancelWorkingSetChange({
    ownerUserId: actor.user.id,
    sessionId,
    changeId,
  })
}

export async function retryIntentWorkingSetChange(
  persistence: IntentPersistence,
  visibility: IntentContextResourceAuthorization,
  actor: Actor,
  sessionId: string,
  changeId: string,
  maxGenerateRounds: number,
): Promise<DrainedIntentWorkingSetChange> {
  return await persistence.retryWorkingSetChange({
    ownerUserId: actor.user.id,
    sessionId,
    changeId,
    maxGenerateRounds,
    visibility,
  })
}
