// RFC-341 — task-execution-owned closed committed-event vocabulary.

import {
  NodeRunStatusSchema,
  TaskStatusSchema,
  type NodeRunStatus,
  type TaskStatus,
} from '@agent-workflow/shared'
import { z } from 'zod'

import type {
  CommittedEventEnvelopeV1,
  DurableCommittedEventConsumer,
} from '@/platform/events/committed/types'

export const TASK_LIFECYCLE_COMMITTED_EVENT_TYPES = [
  'task.created.v1',
  'task.lifecycle-transitioned.v1',
  'task.node-statuses-transitioned.v1',
] as const
export type TaskLifecycleCommittedEventType = (typeof TASK_LIFECYCLE_COMMITTED_EVENT_TYPES)[number]

export type TaskNodeTransitionReasonV1 =
  | 'task-cancel'
  | 'source-termination'
  | 'terminal-reconcile'
  | 'human-gate'
  | 'scheduler'

export type TaskNodeChangeV1 = Readonly<{
  nodeRunId: string
  nodeId: string
  status: NodeRunStatus
  cause: string | null
}>

export type TaskCreatedPayloadV1 = Readonly<{
  taskId: string
  lifecycleRevision: 1
  previousStatus: null
  status: 'pending' | 'failed'
  createdAt: string
  errorSummary: string | null
}>

export type TaskLifecycleTransitionedPayloadV1 = Readonly<{
  taskId: string
  lifecycleRevision: number
  previousStatus: TaskStatus
  status: TaskStatus
  updatedAt: string
  errorSummary: string | null
  nodeChanges: readonly TaskNodeChangeV1[]
  workspacePruneClaim: Readonly<{ claimedAt: string; cause: string }> | null
  sourceTerminationEffectRef: string | null
}>

export type TaskNodeStatusesTransitionedPayloadV1 = Readonly<{
  taskId: string
  reason: TaskNodeTransitionReasonV1
  nodeChanges: readonly TaskNodeChangeV1[]
  updatedAt: string
}>

export type TaskLifecycleCommittedV1 =
  | CommittedEventEnvelopeV1<'task.created.v1', TaskCreatedPayloadV1>
  | CommittedEventEnvelopeV1<'task.lifecycle-transitioned.v1', TaskLifecycleTransitionedPayloadV1>
  | CommittedEventEnvelopeV1<
      'task.node-statuses-transitioned.v1',
      TaskNodeStatusesTransitionedPayloadV1
    >

const nodeChangeSchema = z
  .object({
    nodeRunId: z.string().min(1),
    nodeId: z.string().min(1),
    status: NodeRunStatusSchema,
    cause: z.string().nullable(),
  })
  .strict()

const taskEnvelopeBase = z
  .object({
    eventId: z.string().min(1),
    eventGroupId: z.string().min(1),
    eventGroupOrdinal: z.number().int().nonnegative(),
    schemaVersion: z.literal(1),
    producer: z.literal('task-execution'),
    family: z.literal('task-lifecycle'),
    aggregate: z
      .object({ kind: z.literal('task'), id: z.string().min(1), seq: z.number().int().positive() })
      .strict(),
    operationRef: z.string().min(1),
    correlationRef: z.string().nullable(),
    causationRef: z.string().nullable(),
    occurredAt: z.string().datetime(),
  })
  .strict()

const taskCreatedEventSchema = taskEnvelopeBase
  .extend({
    type: z.literal('task.created.v1'),
    payload: z
      .object({
        taskId: z.string().min(1),
        lifecycleRevision: z.literal(1),
        previousStatus: z.null(),
        status: z.enum(['pending', 'failed']),
        createdAt: z.string().datetime(),
        errorSummary: z.string().nullable(),
      })
      .strict(),
  })
  .strict()

const taskLifecycleTransitionedEventSchema = taskEnvelopeBase
  .extend({
    type: z.literal('task.lifecycle-transitioned.v1'),
    payload: z
      .object({
        taskId: z.string().min(1),
        lifecycleRevision: z.number().int().positive(),
        previousStatus: TaskStatusSchema,
        status: TaskStatusSchema,
        updatedAt: z.string().datetime(),
        errorSummary: z.string().nullable(),
        nodeChanges: z.array(nodeChangeSchema),
        workspacePruneClaim: z
          .object({ claimedAt: z.string().datetime(), cause: z.string().min(1) })
          .strict()
          .nullable(),
        sourceTerminationEffectRef: z.string().min(1).nullable(),
      })
      .strict(),
  })
  .strict()

const taskNodeStatusesTransitionedEventSchema = taskEnvelopeBase
  .extend({
    type: z.literal('task.node-statuses-transitioned.v1'),
    payload: z
      .object({
        taskId: z.string().min(1),
        reason: z.enum([
          'task-cancel',
          'source-termination',
          'terminal-reconcile',
          'human-gate',
          'scheduler',
        ]),
        nodeChanges: z.array(nodeChangeSchema).min(1),
        updatedAt: z.string().datetime(),
      })
      .strict(),
  })
  .strict()

const taskLifecycleCommittedEventSchema = z
  .discriminatedUnion('type', [
    taskCreatedEventSchema,
    taskLifecycleTransitionedEventSchema,
    taskNodeStatusesTransitionedEventSchema,
  ])
  .superRefine((event, context) => {
    if (event.aggregate.id !== event.payload.taskId) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'task event aggregate mismatch' })
    }
    if (
      'lifecycleRevision' in event.payload &&
      event.aggregate.seq !== event.payload.lifecycleRevision
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'task event revision mismatch' })
    }
  })

export function decodeTaskLifecycleCommittedEvent(value: unknown): TaskLifecycleCommittedV1 {
  return taskLifecycleCommittedEventSchema.parse(value) as TaskLifecycleCommittedV1
}

export const TASK_LIFECYCLE_DURABLE_CONSUMER_MANIFEST = [
  {
    id: 'event-center.task-lifecycle',
    eventTypes: ['task.created.v1', 'task.lifecycle-transitioned.v1'],
    deliveryClass: 'critical',
  },
  {
    id: 'task-terminal-gate-close',
    eventTypes: ['task.lifecycle-transitioned.v1'],
    deliveryClass: 'critical',
  },
  {
    id: 'task-child-budget',
    eventTypes: ['task.created.v1', 'task.lifecycle-transitioned.v1'],
    deliveryClass: 'rebuildable',
  },
  {
    id: 'task-execution-watch',
    eventTypes: ['task.lifecycle-transitioned.v1'],
    deliveryClass: 'rebuildable',
  },
  {
    id: 'task-workspace-prune-nudge',
    eventTypes: ['task.lifecycle-transitioned.v1'],
    deliveryClass: 'rebuildable',
  },
  {
    id: 'task-node-reconcile',
    eventTypes: ['task.node-statuses-transitioned.v1'],
    deliveryClass: 'rebuildable',
  },
] as const satisfies readonly Readonly<{
  id: string
  eventTypes: readonly TaskLifecycleCommittedEventType[]
  deliveryClass: DurableCommittedEventConsumer['deliveryClass']
}>[]

export function taskLifecycleDurableConsumers(
  eventType: TaskLifecycleCommittedEventType,
): readonly DurableCommittedEventConsumer[] {
  return TASK_LIFECYCLE_DURABLE_CONSUMER_MANIFEST.filter((consumer) =>
    (consumer.eventTypes as readonly string[]).includes(eventType),
  ).map(({ id, deliveryClass }) => ({ id, deliveryClass }))
}
