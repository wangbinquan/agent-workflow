// RFC-293 — provider-neutral source-bound continuous Intent iteration.

import type {
  IntentGenerationReceipt,
  PostIntentCurrentAction,
  PostIntentIteration,
  PostIntentRetry,
} from '@agent-workflow/shared'

import type { Actor } from '@/auth/actor'
import type {
  IntentContextResourceAuthorization,
  IntentPersistence,
  ReservedIntentTurnRecord,
} from '@/modules/intent/public/operations'

export interface ReservedIntentGeneration {
  receipt: IntentGenerationReceipt
  reservation: ReservedIntentTurnRecord | null
}

export async function reserveIntentIteration(
  persistence: IntentPersistence,
  actor: Actor,
  sessionId: string,
  input: PostIntentIteration,
  maxGenerateRounds: number,
): Promise<ReservedIntentGeneration> {
  return await persistence.reserveIteration({
    ownerUserId: actor.user.id,
    sessionId,
    request: input,
    maxGenerateRounds,
  })
}

export async function reserveExactIntentRetry(
  persistence: IntentPersistence,
  actor: Actor,
  sessionId: string,
  input: PostIntentRetry,
  maxGenerateRounds: number,
): Promise<ReservedIntentGeneration> {
  return await persistence.reserveRetry({
    ownerUserId: actor.user.id,
    sessionId,
    request: input,
    maxGenerateRounds,
  })
}

export async function reserveIntentCurrentAction(
  persistence: IntentPersistence,
  visibility: IntentContextResourceAuthorization,
  actor: Actor,
  sessionId: string,
  input: PostIntentCurrentAction,
  maxGenerateRounds: number,
): Promise<ReservedIntentGeneration> {
  return await persistence.reserveCurrentAction({
    ownerUserId: actor.user.id,
    sessionId,
    request: input,
    maxGenerateRounds,
    visibility,
  })
}
