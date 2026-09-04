// RFC-359 —— collaboration committed event 的**一份**形状 + 中立 append。
//
// 事件的 payload / identity / consumers 形状是纯函数（`*CommittedEventInput`）；同步的 dbTxSync
// 参与者（`collaborationCommittedEventParticipant.ts`，过渡期保留给尚未迁移的同步调用方）与这里的
// `DatabaseTransaction` 版本共用同一份形状。替代此前 PostgreSQL 侧的
// `postgresqlCollaborationCommittedEvents.ts`。

import { appendCommittedEvent } from '@/platform/events/committed/append'
import {
  committedEventGroupId,
  type AppendCommittedEventInput,
  type CommittedEventRef,
} from '@/platform/events/committed/types'
import type { DatabaseTransaction } from '@/platform/persistence/databaseTransaction'
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

function shape<TType extends CollaborationCommittedEventType, TPayload>(
  input: Readonly<{
    family: CollaborationEventFamily
    type: TType
    gate: CollaborationGateRefV1
    occurredAt: number
    payload: TPayload
    identity: CollaborationCommittedEventIdentity
  }>,
): AppendCommittedEventInput<TType, TPayload> {
  return {
    producer: 'collaboration',
    family: input.family,
    type: input.type,
    aggregate: aggregateFor(input.family, input.gate),
    ...identity(input.identity),
    occurredAt: input.occurredAt,
    payload: input.payload,
    consumers: collaborationDurableConsumers(input.family, input.type),
  }
}

export type HumanGateOpenedCommittedEventInput = Readonly<{
  family: CollaborationEventFamily
  gate: CollaborationGateRefV1
  occurredAt: number
  projectionFrames?: readonly CollaborationProjectionFrame[]
  identity: CollaborationCommittedEventIdentity
}>

export function humanGateOpenedCommittedEventInput(input: HumanGateOpenedCommittedEventInput) {
  return shape({
    ...input,
    type: 'collaboration.human-gate-opened.v1',
    payload: {
      gate: input.gate,
      gateStatus: 'open' as const,
      projectionFrames: input.projectionFrames ?? [],
    },
  })
}

export type HumanGateDecisionCommittedEventInput = Readonly<{
  family: CollaborationEventFamily
  gate: CollaborationGateRefV1
  decision: HumanGateDecisionCommittedPayloadV1['decision']
  gateStatus: HumanGateDecisionCommittedPayloadV1['gateStatus']
  continuationRef: string | null
  distillSourceEventId?: string | null
  occurredAt: number
  projectionFrames?: readonly CollaborationProjectionFrame[]
  identity: CollaborationCommittedEventIdentity
}>

export function humanGateDecisionCommittedEventInput(input: HumanGateDecisionCommittedEventInput) {
  return shape({
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

export type ReviewCommentsChangedCommittedEventInput = Readonly<{
  gate: CollaborationGateRefV1
  occurredAt: number
  projectionFrames: readonly Extract<
    CollaborationProjectionFrame,
    { type: 'review.comment_added' | 'review.comment_deleted' | 'review.comment_updated' }
  >[]
  identity: CollaborationCommittedEventIdentity
}>

export function reviewCommentsChangedCommittedEventInput(
  input: ReviewCommentsChangedCommittedEventInput,
) {
  return shape({
    ...input,
    family: 'review',
    type: 'collaboration.review-comments-changed.v1',
    payload: { gate: input.gate, projectionFrames: input.projectionFrames },
  })
}

export type ReviewSelectionChangedCommittedEventInput = Readonly<{
  gate: CollaborationGateRefV1
  occurredAt: number
  projectionFrames: readonly Extract<
    CollaborationProjectionFrame,
    { type: 'review.selection_changed' }
  >[]
  identity: CollaborationCommittedEventIdentity
}>

export function reviewSelectionChangedCommittedEventInput(
  input: ReviewSelectionChangedCommittedEventInput,
) {
  return shape({
    ...input,
    family: 'review',
    type: 'collaboration.review-selection-changed.v1',
    payload: { gate: input.gate, projectionFrames: input.projectionFrames },
  })
}

export type QuestionDispatchCommittedEventInput = Readonly<{
  gate: CollaborationGateRefV1
  questionIds: readonly string[]
  dispatchMode: QuestionDispatchModeV1
  reruns?: QuestionDispatchCommittedPayloadV1['reruns']
  occurredAt: number
  projectionFrames?: readonly CollaborationProjectionFrame[]
  identity: CollaborationCommittedEventIdentity
}>

export function questionDispatchCommittedEventInput(input: QuestionDispatchCommittedEventInput) {
  return shape({
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

export async function appendHumanGateOpenedCommittedEvent(
  tx: DatabaseTransaction,
  input: HumanGateOpenedCommittedEventInput,
): Promise<CommittedEventRef | null> {
  return (await appendCommittedEvent(tx, humanGateOpenedCommittedEventInput(input))).eventRef
}

export async function appendHumanGateDecisionCommittedEvent(
  tx: DatabaseTransaction,
  input: HumanGateDecisionCommittedEventInput,
): Promise<CommittedEventRef | null> {
  return (await appendCommittedEvent(tx, humanGateDecisionCommittedEventInput(input))).eventRef
}

export async function appendReviewCommentsChangedCommittedEvent(
  tx: DatabaseTransaction,
  input: ReviewCommentsChangedCommittedEventInput,
): Promise<CommittedEventRef | null> {
  return (await appendCommittedEvent(tx, reviewCommentsChangedCommittedEventInput(input))).eventRef
}

export async function appendReviewSelectionChangedCommittedEvent(
  tx: DatabaseTransaction,
  input: ReviewSelectionChangedCommittedEventInput,
): Promise<CommittedEventRef | null> {
  return (await appendCommittedEvent(tx, reviewSelectionChangedCommittedEventInput(input))).eventRef
}

export async function appendQuestionDispatchCommittedEvent(
  tx: DatabaseTransaction,
  input: QuestionDispatchCommittedEventInput,
): Promise<CommittedEventRef | null> {
  return (await appendCommittedEvent(tx, questionDispatchCommittedEventInput(input))).eventRef
}
