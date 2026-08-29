// RFC-341 — collaboration-owned transaction participants for closed committed events.

import type { DbTxSync } from '@/db/txSync'
import { appendCommittedEventTx } from '@/platform/events/committed/sqliteStore'
import { committedEventGroupId, type CommittedEventRef } from '@/platform/events/committed/types'
import {
  collaborationDurableConsumers,
  type CollaborationCommittedEventType,
  type CollaborationEventFamily,
  type CollaborationGateRefV1,
  type CollaborationProjectionFrame,
  type HumanGateDecisionCommittedPayloadV1,
  type QuestionDispatchCommittedPayloadV1,
  type QuestionDispatchModeV1,
} from '../domain/collaborationCommittedEvent'

export type CollaborationCommittedEventIdentity = Readonly<{
  operationRef: string
  eventGroupId?: string
  eventGroupOrdinal?: number
  correlationRef?: string | null
  causationRef?: string | null
}>

function aggregateFor(
  family: CollaborationEventFamily,
  gate: CollaborationGateRefV1,
): Readonly<{
  kind: 'review-round' | 'clarify-round' | 'question-gate'
  id: string
}> {
  if (family === 'review') return { kind: 'review-round', id: gate.roundId ?? gate.gateId }
  if (family === 'clarify') return { kind: 'clarify-round', id: gate.roundId ?? gate.gateId }
  return { kind: 'question-gate', id: gate.gateId }
}

function identity(input: CollaborationCommittedEventIdentity) {
  return {
    operationRef: input.operationRef,
    eventGroupId: input.eventGroupId ?? committedEventGroupId('collaboration', input.operationRef),
    eventGroupOrdinal: input.eventGroupOrdinal ?? 0,
    correlationRef: input.correlationRef ?? null,
    causationRef: input.causationRef ?? null,
  }
}

function append<TPayload>(
  tx: DbTxSync,
  input: Readonly<{
    family: CollaborationEventFamily
    type: CollaborationCommittedEventType
    gate: CollaborationGateRefV1
    occurredAt: number
    payload: TPayload
    identity: CollaborationCommittedEventIdentity
  }>,
): CommittedEventRef | null {
  return appendCommittedEventTx(tx, {
    producer: 'collaboration',
    family: input.family,
    type: input.type,
    aggregate: aggregateFor(input.family, input.gate),
    ...identity(input.identity),
    occurredAt: input.occurredAt,
    payload: input.payload,
    consumers: collaborationDurableConsumers(input.family, input.type),
  }).eventRef
}

export function appendHumanGateOpenedCommittedEventTx(
  tx: DbTxSync,
  input: Readonly<{
    family: CollaborationEventFamily
    gate: CollaborationGateRefV1
    occurredAt: number
    projectionFrames?: readonly CollaborationProjectionFrame[]
    identity: CollaborationCommittedEventIdentity
  }>,
): CommittedEventRef | null {
  return append(tx, {
    ...input,
    type: 'collaboration.human-gate-opened.v1',
    payload: {
      gate: input.gate,
      gateStatus: 'open' as const,
      projectionFrames: input.projectionFrames ?? [],
    },
  })
}

export function appendHumanGateDecisionCommittedEventTx(
  tx: DbTxSync,
  input: Readonly<{
    family: CollaborationEventFamily
    gate: CollaborationGateRefV1
    decision: HumanGateDecisionCommittedPayloadV1['decision']
    gateStatus: HumanGateDecisionCommittedPayloadV1['gateStatus']
    continuationRef: string | null
    distillSourceEventId?: string | null
    occurredAt: number
    projectionFrames?: readonly CollaborationProjectionFrame[]
    identity: CollaborationCommittedEventIdentity
  }>,
): CommittedEventRef | null {
  return append(tx, {
    ...input,
    type: 'collaboration.human-gate-decision-committed.v1',
    payload: {
      gate: input.gate,
      decision: input.decision,
      gateStatus: input.gateStatus,
      continuationRef: input.continuationRef,
      distillSourceEventId: input.distillSourceEventId ?? null,
      projectionFrames: input.projectionFrames ?? [],
    },
  })
}

export function appendReviewCommentsChangedCommittedEventTx(
  tx: DbTxSync,
  input: Readonly<{
    gate: CollaborationGateRefV1
    occurredAt: number
    projectionFrames: readonly Extract<
      CollaborationProjectionFrame,
      { type: 'review.comment_added' | 'review.comment_deleted' | 'review.comment_updated' }
    >[]
    identity: CollaborationCommittedEventIdentity
  }>,
): CommittedEventRef | null {
  return append(tx, {
    ...input,
    family: 'review',
    type: 'collaboration.review-comments-changed.v1',
    payload: { gate: input.gate, projectionFrames: input.projectionFrames },
  })
}

export function appendReviewSelectionChangedCommittedEventTx(
  tx: DbTxSync,
  input: Readonly<{
    gate: CollaborationGateRefV1
    occurredAt: number
    projectionFrames: readonly Extract<
      CollaborationProjectionFrame,
      { type: 'review.selection_changed' }
    >[]
    identity: CollaborationCommittedEventIdentity
  }>,
): CommittedEventRef | null {
  return append(tx, {
    ...input,
    family: 'review',
    type: 'collaboration.review-selection-changed.v1',
    payload: { gate: input.gate, projectionFrames: input.projectionFrames },
  })
}

export function appendQuestionDispatchCommittedEventTx(
  tx: DbTxSync,
  input: Readonly<{
    gate: CollaborationGateRefV1
    questionIds: readonly string[]
    dispatchMode: QuestionDispatchModeV1
    reruns?: QuestionDispatchCommittedPayloadV1['reruns']
    occurredAt: number
    projectionFrames?: readonly CollaborationProjectionFrame[]
    identity: CollaborationCommittedEventIdentity
  }>,
): CommittedEventRef | null {
  return append(tx, {
    ...input,
    family: 'questions',
    type: 'collaboration.question-dispatch-committed.v1',
    payload: {
      gate: input.gate,
      questionIds: input.questionIds,
      dispatchMode: input.dispatchMode,
      reruns: input.reruns ?? [],
      projectionFrames: input.projectionFrames ?? [],
    },
  })
}
