// RFC-359 —— task-lifecycle committed event 的**一份**形状 + 中立 append。
//
// 事件的 payload / identity / consumers 形状是纯函数（`*CommittedEventInput`），同步的 dbTxSync
// 参与者（`taskLifecycleEventParticipant.ts`，过渡期保留给尚未迁移的同步调用方）与这里的
// `DatabaseTransaction` 版本共用同一份形状——两个引擎、两种事务形态，事件内容只有一个定义。

import type { TaskStatus } from '@agent-workflow/shared'

import { appendCommittedEvent } from '@/platform/events/committed/append'
import {
  committedEventGroupId,
  type AppendCommittedEventInput,
  type CommittedEventRef,
} from '@/platform/events/committed/types'
import type { DatabaseTransaction } from '@/platform/persistence/databaseTransaction'
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

export type TaskCreatedCommittedEventInput = Readonly<{
  taskId: string
  status: TaskCreatedPayloadV1['status']
  errorSummary: string | null
  occurredAt: number
  identity?: Partial<TaskCommittedEventIdentity>
}>

export function taskCreatedCommittedEventInput(
  input: TaskCreatedCommittedEventInput,
): AppendCommittedEventInput<'task.created.v1', TaskCreatedPayloadV1> {
  const identity = eventIdentity(`task-lifecycle:${input.taskId}:1`, input.identity)
  return {
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
  }
}

export type TaskLifecycleTransitionCommittedEventInput = Readonly<{
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
}>

export function taskLifecycleTransitionCommittedEventInput(
  input: TaskLifecycleTransitionCommittedEventInput,
): AppendCommittedEventInput<'task.lifecycle-transitioned.v1', TaskLifecycleTransitionedPayloadV1> {
  const identity = eventIdentity(
    `task-lifecycle:${input.taskId}:${input.lifecycleRevision}`,
    input.identity,
  )
  return {
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
  }
}

export type TaskNodeStatusesCommittedEventInput = Readonly<{
  taskId: string
  /** 缺省 'source-termination'：PostgreSQL 侧此前的缺省，保留以免改变既有调用方的事件内容。 */
  reason?: TaskNodeStatusesTransitionedPayloadV1['reason']
  nodeChanges: readonly TaskNodeChangeV1[]
  occurredAt: number
  identity: TaskCommittedEventIdentity
}>

export function taskNodeStatusesCommittedEventInput(
  input: TaskNodeStatusesCommittedEventInput,
): AppendCommittedEventInput<
  'task.node-statuses-transitioned.v1',
  TaskNodeStatusesTransitionedPayloadV1
> {
  const identity = eventIdentity(input.identity.operationRef, input.identity)
  return {
    producer: 'task-execution',
    family: 'task-lifecycle',
    type: 'task.node-statuses-transitioned.v1',
    aggregate: { kind: 'task', id: input.taskId },
    ...identity,
    occurredAt: input.occurredAt,
    payload: {
      taskId: input.taskId,
      reason: input.reason ?? 'source-termination',
      nodeChanges: input.nodeChanges,
      updatedAt: new Date(input.occurredAt).toISOString(),
    },
    consumers: taskLifecycleDurableConsumers('task.node-statuses-transitioned.v1'),
  }
}

export async function appendTaskCreatedCommittedEvent(
  tx: DatabaseTransaction,
  input: TaskCreatedCommittedEventInput,
): Promise<CommittedEventRef | null> {
  return (await appendCommittedEvent(tx, taskCreatedCommittedEventInput(input))).eventRef
}

export async function appendTaskLifecycleTransitionCommittedEvent(
  tx: DatabaseTransaction,
  input: TaskLifecycleTransitionCommittedEventInput,
): Promise<CommittedEventRef | null> {
  return (await appendCommittedEvent(tx, taskLifecycleTransitionCommittedEventInput(input)))
    .eventRef
}

export async function appendTaskNodeStatusesCommittedEvent(
  tx: DatabaseTransaction,
  input: TaskNodeStatusesCommittedEventInput,
): Promise<CommittedEventRef | null> {
  return (await appendCommittedEvent(tx, taskNodeStatusesCommittedEventInput(input))).eventRef
}
