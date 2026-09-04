// RFC-359 —— human-gate 的任务生命周期跃迁：一份实现，两个引擎。
//
// 蓝本是 `platform/persistence/sqlite/taskLifecycle.ts` 的 `transitionHumanGateTaskTx`（生产跑了
// 最久的那份），语义与错误类逐条保留：任务不存在 → NotFoundError('task-not-found')；修订号不符 /
// CAS 失败 → ConcurrentTaskTransition；状态不在合法源集合 → ConflictError('illegal-task-transition')。
// 此前 PostgreSQL 侧的重推（`transitionPostgresqlHumanGateTaskTx`）把这三类都折成了
// TaskExecutionError('task-continuation-*')——同一个端口两种回答，正是 RFC-359 要消灭的 A 类缺陷。
//
// 只支持 human-gate 的四条边，不接受任意 status/extra；调用方在 `DatabaseSession.transaction`
// 体内传 `tx`。PostgreSQL READ COMMITTED 下 CAS（status + lifecycle_event_revision 双条件 UPDATE）
// 自身即是并发判据；需要与同任务的其它写手串行时由调用方先 `engineOf(tx).lockAggregateRoot`。

import {
  allowedFromForTaskEvent,
  targetForTaskEvent,
  type TaskStatus,
  type TaskTransitionEvent,
} from '@agent-workflow/shared'
import { and, eq, sql } from 'drizzle-orm'

import { tasks } from '@/db/schema'
import type { CommittedEventRef } from '@/platform/events/committed/types'
import type { DatabaseTransaction } from '@/platform/persistence/databaseTransaction'
import { ConcurrentTaskTransition } from '@/platform/persistence/sqlite/taskLifecycle'
import { ConflictError, NotFoundError } from '@/util/errors'
import type { TaskNodeChangeV1 } from '../domain/taskLifecycleCommittedEvent'
import type { HumanGateTaskTransition } from './humanGateTaskLifecycleTransaction'
import {
  appendTaskLifecycleTransitionCommittedEvent,
  type TaskCommittedEventIdentity,
} from './taskLifecycleCommittedEvents'

export type TransitionHumanGateTaskInput = Readonly<{
  taskId: string
  expectedTaskRevision: number
  transition: HumanGateTaskTransition
  now: number
  nodeChanges?: readonly TaskNodeChangeV1[]
  committedEventIdentity?: Partial<TaskCommittedEventIdentity>
}>

export type TransitionedHumanGateTask = Readonly<{
  from: TaskStatus
  to: TaskStatus
  taskRevision: number
  eventRefs: readonly CommittedEventRef[]
}>

export async function transitionHumanGateTask(
  tx: DatabaseTransaction,
  input: TransitionHumanGateTaskInput,
): Promise<TransitionedHumanGateTask> {
  const row = await tx
    .select({
      status: tasks.status,
      lifecycleEventRevision: tasks.lifecycleEventRevision,
      errorSummary: tasks.errorSummary,
    })
    .from(tasks)
    .where(eq(tasks.id, input.taskId))
    .get()
  if (row === undefined) {
    throw new NotFoundError('task-not-found', `task ${input.taskId} not found`)
  }
  if (row.lifecycleEventRevision !== input.expectedTaskRevision) {
    throw new ConcurrentTaskTransition(
      input.taskId,
      [row.status],
      `human-gate revision changed (expected ${input.expectedTaskRevision}, current ${row.lifecycleEventRevision})`,
    )
  }

  // Several review branches may park in the same scheduler wave. The first gate performs
  // running→awaiting_review; later gates join the already-parked task at the exact same
  // lifecycle revision while committing their own manifests — an idempotent target, not a
  // second status writer.
  if (
    (input.transition === 'park-review' && row.status === 'awaiting_review') ||
    (input.transition === 'park-human' && row.status === 'awaiting_human')
  ) {
    return {
      from: row.status,
      to: row.status,
      taskRevision: row.lifecycleEventRevision,
      eventRefs: [],
    }
  }

  const event: TaskTransitionEvent =
    input.transition === 'park-review'
      ? { kind: 'park-review' }
      : input.transition === 'park-human'
        ? { kind: 'park-human' }
        : { kind: 'resume' }
  const expectedFrom: readonly TaskStatus[] =
    input.transition === 'release-review'
      ? ['awaiting_review']
      : input.transition === 'release-human'
        ? ['awaiting_human']
        : allowedFromForTaskEvent(event)
  const from = row.status as TaskStatus
  if (!expectedFrom.includes(from)) {
    throw new ConflictError(
      'illegal-task-transition',
      `task ${input.taskId} status='${from}' cannot ${input.transition}`,
    )
  }
  const release = input.transition === 'release-review' || input.transition === 'release-human'
  const to = targetForTaskEvent(event)
  const updated = await tx
    .update(tasks)
    .set({
      status: to,
      ...(to === 'running'
        ? { runningSince: input.now }
        : from === 'running'
          ? {
              runningMs: sql`${tasks.runningMs} + (${input.now} - COALESCE(${tasks.runningSince}, ${input.now}))`,
              runningSince: null,
            }
          : {}),
      ...(release
        ? { finishedAt: null, errorSummary: null, errorMessage: null, failedNodeId: null }
        : {}),
      lifecycleEventRevision: sql`${tasks.lifecycleEventRevision} + 1`,
    })
    .where(
      and(
        eq(tasks.id, input.taskId),
        eq(tasks.status, from),
        eq(tasks.lifecycleEventRevision, input.expectedTaskRevision),
      ),
    )
    .returning({ lifecycleEventRevision: tasks.lifecycleEventRevision })
  const changed = updated[0]
  if (changed === undefined) {
    throw new ConcurrentTaskTransition(
      input.taskId,
      expectedFrom,
      `human-gate:${input.transition}`,
    )
  }
  const eventRef = await appendTaskLifecycleTransitionCommittedEvent(tx, {
    taskId: input.taskId,
    lifecycleRevision: changed.lifecycleEventRevision,
    previousStatus: from,
    status: to,
    errorSummary: release ? null : row.errorSummary,
    nodeChanges: input.nodeChanges ?? [],
    workspacePruneClaim: null,
    sourceTerminationEffectRef: null,
    occurredAt: input.now,
    ...(input.committedEventIdentity === undefined
      ? {}
      : { identity: input.committedEventIdentity }),
  })
  return {
    from,
    to,
    taskRevision: changed.lifecycleEventRevision,
    eventRefs: eventRef === null ? [] : [eventRef],
  }
}
