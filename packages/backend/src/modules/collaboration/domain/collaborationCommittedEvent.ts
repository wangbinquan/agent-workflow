// RFC-341 — collaboration-owned closed committed-event vocabulary.

import {
  ClarifyDirectiveSchema,
  ReviewDecisionKindSchema,
  TaskWsMessageSchema,
  type TaskWsMessage,
} from '@agent-workflow/shared'
import { z } from 'zod'

import type {
  CommittedEventEnvelopeV1,
  CommittedEventFamily,
  DurableCommittedEventConsumer,
} from '@/platform/events/committed/types'

export const COLLABORATION_COMMITTED_EVENT_TYPES = [
  'collaboration.human-gate-opened.v1',
  'collaboration.human-gate-decision-committed.v1',
  'collaboration.review-comments-changed.v1',
  'collaboration.review-selection-changed.v1',
  'collaboration.question-dispatch-committed.v1',
] as const
export type CollaborationCommittedEventType = (typeof COLLABORATION_COMMITTED_EVENT_TYPES)[number]

export type CollaborationEventFamily = Exclude<CommittedEventFamily, 'task-lifecycle'>
export type HumanGateStatusV1 = 'open' | 'committed' | 'deferred' | 'closed'
export type QuestionDispatchModeV1 = 'immediate' | 'deferred' | 'mixed' | 'none'

export type CollaborationProjectionFrame = Extract<
  TaskWsMessage,
  {
    type:
      | 'review.created'
      | 'review.decision_made'
      | 'review.comment_added'
      | 'review.comment_deleted'
      | 'review.comment_updated'
      | 'review.selection_changed'
      | 'clarify.created'
      | 'clarify.answered'
      | 'cross-clarify.created'
      | 'cross-clarify.answered'
      | 'cross-clarify.rejected'
  }
>

export type CollaborationGateRefV1 = Readonly<{
  taskId: string
  nodeRunId: string
  gateKind: 'review' | 'clarify' | 'questions'
  gateId: string
  roundId: string | null
}>

export type HumanGateOpenedPayloadV1 = Readonly<{
  gate: CollaborationGateRefV1
  gateStatus: 'open'
  projectionFrames: readonly CollaborationProjectionFrame[]
}>

export type HumanGateDecisionCommittedPayloadV1 = Readonly<{
  gate: CollaborationGateRefV1
  decision:
    | Readonly<{ gateKind: 'review'; kind: 'approved' | 'rejected' | 'iterated' }>
    | Readonly<{ gateKind: 'clarify'; kind: 'continue' | 'stop' }>
    | Readonly<{ gateKind: 'questions'; kind: 'dispatched' }>
  gateStatus: Exclude<HumanGateStatusV1, 'open'>
  continuationRef: string | null
  distillSourceEventId: string | null
  projectionFrames: readonly CollaborationProjectionFrame[]
}>

export type ReviewCommentsChangedPayloadV1 = Readonly<{
  gate: CollaborationGateRefV1
  projectionFrames: readonly Extract<
    CollaborationProjectionFrame,
    {
      type: 'review.comment_added' | 'review.comment_deleted' | 'review.comment_updated'
    }
  >[]
}>

export type ReviewSelectionChangedPayloadV1 = Readonly<{
  gate: CollaborationGateRefV1
  projectionFrames: readonly Extract<
    CollaborationProjectionFrame,
    { type: 'review.selection_changed' }
  >[]
}>

export type QuestionDispatchCommittedPayloadV1 = Readonly<{
  gate: CollaborationGateRefV1
  questionIds: readonly string[]
  dispatchMode: QuestionDispatchModeV1
  reruns: readonly Readonly<{
    nodeRunId: string
    nodeId: string
    entryIds: readonly string[]
  }>[]
  projectionFrames: readonly CollaborationProjectionFrame[]
}>

export type CollaborationCommittedV1 =
  | CommittedEventEnvelopeV1<'collaboration.human-gate-opened.v1', HumanGateOpenedPayloadV1>
  | CommittedEventEnvelopeV1<
      'collaboration.human-gate-decision-committed.v1',
      HumanGateDecisionCommittedPayloadV1
    >
  | CommittedEventEnvelopeV1<
      'collaboration.review-comments-changed.v1',
      ReviewCommentsChangedPayloadV1
    >
  | CommittedEventEnvelopeV1<
      'collaboration.review-selection-changed.v1',
      ReviewSelectionChangedPayloadV1
    >
  | CommittedEventEnvelopeV1<
      'collaboration.question-dispatch-committed.v1',
      QuestionDispatchCommittedPayloadV1
    >

const ALLOWED_COLLABORATION_FRAME_TYPES: ReadonlySet<string> = new Set([
  'review.created',
  'review.decision_made',
  'review.comment_added',
  'review.comment_deleted',
  'review.comment_updated',
  'review.selection_changed',
  'clarify.created',
  'clarify.answered',
  'cross-clarify.created',
  'cross-clarify.answered',
  'cross-clarify.rejected',
])

const collaborationProjectionFrameSchema = TaskWsMessageSchema.refine(
  (frame) => ALLOWED_COLLABORATION_FRAME_TYPES.has(frame.type),
  'frame type is not owned by collaboration committed events',
)

const gateRefSchema = z
  .object({
    taskId: z.string().min(1),
    nodeRunId: z.string().min(1),
    gateKind: z.enum(['review', 'clarify', 'questions']),
    gateId: z.string().min(1),
    roundId: z.string().min(1).nullable(),
  })
  .strict()

const collaborationEnvelopeBase = z
  .object({
    eventId: z.string().min(1),
    eventGroupId: z.string().min(1),
    eventGroupOrdinal: z.number().int().nonnegative(),
    schemaVersion: z.literal(1),
    producer: z.literal('collaboration'),
    family: z.enum(['review', 'clarify', 'questions']),
    aggregate: z
      .object({
        kind: z.enum(['review-round', 'clarify-round', 'question-gate']),
        id: z.string().min(1),
        seq: z.number().int().positive(),
      })
      .strict(),
    operationRef: z.string().min(1),
    correlationRef: z.string().nullable(),
    causationRef: z.string().nullable(),
    occurredAt: z.string().datetime(),
  })
  .strict()

const humanGateOpenedSchema = collaborationEnvelopeBase
  .extend({
    type: z.literal('collaboration.human-gate-opened.v1'),
    payload: z
      .object({
        gate: gateRefSchema,
        gateStatus: z.literal('open'),
        projectionFrames: z.array(collaborationProjectionFrameSchema),
      })
      .strict(),
  })
  .strict()

const humanGateDecisionSchema = collaborationEnvelopeBase
  .extend({
    type: z.literal('collaboration.human-gate-decision-committed.v1'),
    payload: z
      .object({
        gate: gateRefSchema,
        decision: z.discriminatedUnion('gateKind', [
          z.object({ gateKind: z.literal('review'), kind: ReviewDecisionKindSchema }).strict(),
          z.object({ gateKind: z.literal('clarify'), kind: ClarifyDirectiveSchema }).strict(),
          z.object({ gateKind: z.literal('questions'), kind: z.literal('dispatched') }).strict(),
        ]),
        gateStatus: z.enum(['committed', 'deferred', 'closed']),
        continuationRef: z.string().min(1).nullable(),
        distillSourceEventId: z.string().min(1).nullable(),
        projectionFrames: z.array(collaborationProjectionFrameSchema),
      })
      .strict(),
  })
  .strict()

const reviewCommentsChangedSchema = collaborationEnvelopeBase
  .extend({
    type: z.literal('collaboration.review-comments-changed.v1'),
    payload: z
      .object({
        gate: gateRefSchema,
        projectionFrames: z
          .array(collaborationProjectionFrameSchema)
          .min(1)
          .refine(
            (frames) =>
              frames.every((frame) =>
                [
                  'review.comment_added',
                  'review.comment_deleted',
                  'review.comment_updated',
                ].includes(frame.type),
              ),
            'review comment event contains a non-comment frame',
          ),
      })
      .strict(),
  })
  .strict()

const reviewSelectionChangedSchema = collaborationEnvelopeBase
  .extend({
    type: z.literal('collaboration.review-selection-changed.v1'),
    payload: z
      .object({
        gate: gateRefSchema,
        projectionFrames: z
          .array(collaborationProjectionFrameSchema)
          .min(1)
          .refine(
            (frames) => frames.every((frame) => frame.type === 'review.selection_changed'),
            'review selection event contains a non-selection frame',
          ),
      })
      .strict(),
  })
  .strict()

const questionDispatchCommittedSchema = collaborationEnvelopeBase
  .extend({
    type: z.literal('collaboration.question-dispatch-committed.v1'),
    payload: z
      .object({
        gate: gateRefSchema,
        questionIds: z.array(z.string().min(1)),
        dispatchMode: z.enum(['immediate', 'deferred', 'mixed', 'none']),
        reruns: z.array(
          z
            .object({
              nodeRunId: z.string().min(1),
              nodeId: z.string().min(1),
              entryIds: z.array(z.string().min(1)),
            })
            .strict(),
        ),
        projectionFrames: z.array(collaborationProjectionFrameSchema),
      })
      .strict(),
  })
  .strict()

const collaborationCommittedEventSchema = z
  .discriminatedUnion('type', [
    humanGateOpenedSchema,
    humanGateDecisionSchema,
    reviewCommentsChangedSchema,
    reviewSelectionChangedSchema,
    questionDispatchCommittedSchema,
  ])
  .superRefine((event, context) => {
    const expectedFamily = event.payload.gate.gateKind
    if (event.family !== expectedFamily) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'collaboration family mismatch' })
    }
    const expectedAggregate =
      event.family === 'review'
        ? {
            kind: 'review-round' as const,
            id: event.payload.gate.roundId ?? event.payload.gate.gateId,
          }
        : event.family === 'clarify'
          ? {
              kind: 'clarify-round' as const,
              id: event.payload.gate.roundId ?? event.payload.gate.gateId,
            }
          : { kind: 'question-gate' as const, id: event.payload.gate.gateId }
    if (
      event.aggregate.kind !== expectedAggregate.kind ||
      event.aggregate.id !== expectedAggregate.id
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'collaboration event aggregate mismatch',
      })
    }
    if (
      event.type === 'collaboration.human-gate-decision-committed.v1' &&
      event.payload.decision.gateKind !== event.payload.gate.gateKind
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'collaboration decision mismatch' })
    }
    if (
      event.type === 'collaboration.human-gate-decision-committed.v1' &&
      event.family !== 'review' &&
      event.payload.distillSourceEventId !== null
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'collaboration distill source is review-only',
      })
    }
    if (
      (event.type === 'collaboration.review-comments-changed.v1' ||
        event.type === 'collaboration.review-selection-changed.v1') &&
      event.family !== 'review'
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'review event family mismatch' })
    }
    if (
      event.type === 'collaboration.question-dispatch-committed.v1' &&
      event.family !== 'questions'
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'question event family mismatch' })
    }
  })

export function decodeCollaborationCommittedEvent(value: unknown): CollaborationCommittedV1 {
  return collaborationCommittedEventSchema.parse(value) as CollaborationCommittedV1
}

export function decodeQuestionDispatchCommittedPayload(
  value: unknown,
): QuestionDispatchCommittedPayloadV1 {
  return questionDispatchCommittedSchema.shape.payload.parse(
    value,
  ) as QuestionDispatchCommittedPayloadV1
}

export const COLLABORATION_DURABLE_CONSUMER_MANIFEST = [
  {
    id: 'event-center.collaboration',
    eventTypes: COLLABORATION_COMMITTED_EVENT_TYPES,
    deliveryClass: 'critical',
  },
  {
    id: 'collaboration-continuation-nudge',
    eventTypes: ['collaboration.human-gate-decision-committed.v1'],
    deliveryClass: 'rebuildable',
  },
  {
    id: 'review-distill-enqueue',
    eventTypes: ['collaboration.human-gate-decision-committed.v1'],
    deliveryClass: 'rebuildable',
  },
] as const satisfies readonly Readonly<{
  id: string
  eventTypes: readonly CollaborationCommittedEventType[]
  deliveryClass: DurableCommittedEventConsumer['deliveryClass']
}>[]

export function collaborationDurableConsumers(
  family: CollaborationEventFamily,
  eventType: CollaborationCommittedEventType,
): readonly DurableCommittedEventConsumer[] {
  return COLLABORATION_DURABLE_CONSUMER_MANIFEST.filter((consumer) => {
    if (!(consumer.eventTypes as readonly string[]).includes(eventType)) return false
    if (consumer.id === 'review-distill-enqueue' && family !== 'review') return false
    return true
  }).map(({ id, deliveryClass }) => ({ id, deliveryClass }))
}
