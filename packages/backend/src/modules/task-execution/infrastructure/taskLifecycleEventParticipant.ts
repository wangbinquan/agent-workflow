import type { TaskStatus } from '@agent-workflow/shared'

import type { DbTxSync } from '@/db/txSync'
import { appendCommittedEventTx } from '@/platform/events/committed/sqliteStore'
import { committedEventGroupId, type CommittedEventRef } from '@/platform/events/committed/types'
import {
  taskLifecycleDurableConsumers,
  type TaskCreatedPayloadV1,
  type TaskLifecycleTransitionedPayloadV1,
  type TaskNodeChangeV1,
  type TaskNodeStatusesTransitionedPayloadV1,
} from '../domain/taskLifecycleCommittedEvent'

export type TaskCommittedEventIdentity = Readonly<{
  operationRef: string
  eventGroupId?: string
  eventGroupOrdinal?: number
  correlationRef?: string | null
  causationRef?: string | null
}>

function eventIdentity(
  operationRef: string,
  identity?: Partial<TaskCommittedEventIdentity>,
): Required<
  Pick<TaskCommittedEventIdentity, 'operationRef' | 'eventGroupId' | 'eventGroupOrdinal'>
> &
  Pick<TaskCommittedEventIdentity, 'correlationRef' | 'causationRef'> {
  const resolvedOperationRef = identity?.operationRef ?? operationRef
  return {
    operationRef: resolvedOperationRef,
    eventGroupId:
      identity?.eventGroupId ?? committedEventGroupId('task-execution', resolvedOperationRef),
    eventGroupOrdinal: identity?.eventGroupOrdinal ?? 0,
    correlationRef: identity?.correlationRef ?? null,
    causationRef: identity?.causationRef ?? null,
  }
}

export function appendTaskCreatedCommittedEventTx(
  tx: DbTxSync,
  input: Readonly<{
    taskId: string
    status: TaskCreatedPayloadV1['status']
    errorSummary: string | null
    occurredAt: number
    identity?: Partial<TaskCommittedEventIdentity>
  }>,
): CommittedEventRef | null {
  const identity = eventIdentity(`task-lifecycle:${input.taskId}:1`, input.identity)
  return appendCommittedEventTx(tx, {
    producer: 'task-execution',
    family: 'task-lifecycle',
    type: 'task.created.v1',
    aggregate: { kind: 'task', id: input.taskId, seq: 1 },
    eventId: `task-lifecycle:${input.taskId}:1`,
    ...identity,
    occurredAt: input.occurredAt,
    payload: {
      taskId: input.taskId,
      lifecycleRevision: 1,
      previousStatus: null,
      status: input.status,
      createdAt: new Date(input.occurredAt).toISOString(),
      errorSummary: input.errorSummary,
    },
    consumers: taskLifecycleDurableConsumers('task.created.v1'),
  }).eventRef
}

export function appendTaskLifecycleTransitionCommittedEventTx(
  tx: DbTxSync,
  input: Readonly<{
    taskId: string
    lifecycleRevision: number
    previousStatus: TaskStatus
    status: TaskStatus
    errorSummary: string | null
    nodeChanges?: readonly TaskNodeChangeV1[]
    workspacePruneClaim?: TaskLifecycleTransitionedPayloadV1['workspacePruneClaim']
    sourceTerminationEffectRef?: string | null
    occurredAt: number
    identity?: Partial<TaskCommittedEventIdentity>
  }>,
): CommittedEventRef | null {
  const identity = eventIdentity(
    `task-lifecycle:${input.taskId}:${input.lifecycleRevision}`,
    input.identity,
  )
  return appendCommittedEventTx(tx, {
    producer: 'task-execution',
    family: 'task-lifecycle',
    type: 'task.lifecycle-transitioned.v1',
    aggregate: { kind: 'task', id: input.taskId },
    eventId: `task-lifecycle:${input.taskId}:${input.lifecycleRevision}`,
    ...identity,
    occurredAt: input.occurredAt,
    payload: {
      taskId: input.taskId,
      lifecycleRevision: input.lifecycleRevision,
      previousStatus: input.previousStatus,
      status: input.status,
      updatedAt: new Date(input.occurredAt).toISOString(),
      errorSummary: input.errorSummary,
      nodeChanges: input.nodeChanges ?? [],
      workspacePruneClaim: input.workspacePruneClaim ?? null,
      sourceTerminationEffectRef: input.sourceTerminationEffectRef ?? null,
    },
    consumers: taskLifecycleDurableConsumers('task.lifecycle-transitioned.v1'),
  }).eventRef
}

export function appendTaskNodeStatusesCommittedEventTx(
  tx: DbTxSync,
  input: Readonly<{
    taskId: string
    reason: TaskNodeStatusesTransitionedPayloadV1['reason']
    nodeChanges: readonly TaskNodeChangeV1[]
    occurredAt: number
    identity: TaskCommittedEventIdentity
  }>,
): CommittedEventRef | null {
  const identity = eventIdentity(input.identity.operationRef, input.identity)
  return appendCommittedEventTx(tx, {
    producer: 'task-execution',
    family: 'task-lifecycle',
    type: 'task.node-statuses-transitioned.v1',
    aggregate: { kind: 'task', id: input.taskId },
    ...identity,
    occurredAt: input.occurredAt,
    payload: {
      taskId: input.taskId,
      reason: input.reason,
      nodeChanges: input.nodeChanges,
      updatedAt: new Date(input.occurredAt).toISOString(),
    },
    consumers: taskLifecycleDurableConsumers('task.node-statuses-transitioned.v1'),
  }).eventRef
}
