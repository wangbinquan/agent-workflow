// RFC-328 — retained operation-family watermarks and actor replay decisions.

export const LINEAGE_OPERATION_RECORD_KINDS = ['generation-watermark', 'replay-decision'] as const
export type LineageOperationRecordKind = (typeof LINEAGE_OPERATION_RECORD_KINDS)[number]

export const REPLAY_DECISION_STATES = [
  'requires-actor',
  'actor-replay-authorized',
  'actor-replay-authorized-suspended',
  'consumed',
] as const
export type ReplayDecisionState = (typeof REPLAY_DECISION_STATES)[number]

export interface GenerationWatermark {
  readonly kind: 'generation-watermark'
  readonly executionLineageId: string
  readonly operationFamilyKey: string
  readonly highestSettledGeneration: number
  readonly requestHash: string
  readonly slotPathDigest: string
  readonly outcome: string
  readonly revision: number
}

export interface ReplayDecision {
  readonly kind: 'replay-decision'
  readonly executionLineageId: string
  readonly operationFamilyKey: string
  readonly operationGeneration: number
  readonly requestHash: string
  readonly slotPathDigest: string
  readonly state: ReplayDecisionState
  readonly revision: number
  readonly authorizationId: string | null
  readonly boundIntentId: string | null
}

export type LineageOperationRecord = GenerationWatermark | ReplayDecision

export function nextOperationGeneration(input: {
  liveGenerations: readonly number[]
  watermark: GenerationWatermark | null
}): number {
  let highest = input.watermark?.highestSettledGeneration ?? -1
  for (const generation of input.liveGenerations) {
    if (!Number.isInteger(generation) || generation < 0) {
      throw new Error('invalid-operation-generation')
    }
    highest = Math.max(highest, generation)
  }
  return highest + 1
}

export function advanceGenerationWatermark(input: {
  current: GenerationWatermark | null
  executionLineageId: string
  operationFamilyKey: string
  settledGeneration: number
  requestHash: string
  slotPathDigest: string
  outcome: string
}): GenerationWatermark {
  if (input.settledGeneration < 0 || !Number.isInteger(input.settledGeneration)) {
    throw new Error('invalid-operation-generation')
  }
  const current = input.current
  if (current !== null) {
    if (
      current.executionLineageId !== input.executionLineageId ||
      current.operationFamilyKey !== input.operationFamilyKey
    ) {
      throw new Error('watermark-family-mismatch')
    }
    if (input.settledGeneration < current.highestSettledGeneration) {
      throw new Error('operation-generation-regression')
    }
    if (
      input.settledGeneration === current.highestSettledGeneration &&
      (current.requestHash !== input.requestHash ||
        current.slotPathDigest !== input.slotPathDigest ||
        current.outcome !== input.outcome)
    ) {
      throw new Error('operation-generation-digest-mismatch')
    }
  }
  return {
    kind: 'generation-watermark',
    executionLineageId: input.executionLineageId,
    operationFamilyKey: input.operationFamilyKey,
    highestSettledGeneration: Math.max(
      current?.highestSettledGeneration ?? -1,
      input.settledGeneration,
    ),
    requestHash: input.requestHash,
    slotPathDigest: input.slotPathDigest,
    outcome: input.outcome,
    revision: (current?.revision ?? 0) + 1,
  }
}

export type ReplayDecisionEvent =
  | Readonly<{ kind: 'authorize'; authorizationId: string; intentId: string }>
  | Readonly<{ kind: 'suspend' }>
  | Readonly<{ kind: 'rebind'; intentId: string }>
  | Readonly<{ kind: 'return-to-actor' }>
  | Readonly<{ kind: 'consume'; effectId: string }>

export function transitionReplayDecision(
  decision: ReplayDecision,
  event: ReplayDecisionEvent,
): ReplayDecision {
  const next = { ...decision, revision: decision.revision + 1 }
  switch (event.kind) {
    case 'authorize':
      if (decision.state !== 'requires-actor') throw new Error('replay-decision-not-authorizable')
      if (event.authorizationId.length === 0 || event.intentId.length === 0) {
        throw new Error('replay-authorization-invalid')
      }
      return {
        ...next,
        state: 'actor-replay-authorized',
        authorizationId: event.authorizationId,
        boundIntentId: event.intentId,
      }
    case 'suspend':
      if (decision.state !== 'actor-replay-authorized') {
        throw new Error('replay-decision-not-suspendable')
      }
      return { ...next, state: 'actor-replay-authorized-suspended', boundIntentId: null }
    case 'rebind':
      if (
        decision.state !== 'actor-replay-authorized' &&
        decision.state !== 'actor-replay-authorized-suspended'
      ) {
        throw new Error('replay-decision-not-rebindable')
      }
      return { ...next, state: 'actor-replay-authorized', boundIntentId: event.intentId }
    case 'return-to-actor':
      if (
        decision.state !== 'actor-replay-authorized' &&
        decision.state !== 'actor-replay-authorized-suspended'
      ) {
        throw new Error('replay-decision-not-returnable')
      }
      return { ...next, state: 'requires-actor', authorizationId: null, boundIntentId: null }
    case 'consume':
      if (decision.state !== 'actor-replay-authorized') {
        throw new Error('replay-decision-not-consumable')
      }
      if (event.effectId.length === 0 || decision.boundIntentId === null) {
        throw new Error('replay-decision-missing-binding')
      }
      return { ...next, state: 'consumed', boundIntentId: null }
  }
}
