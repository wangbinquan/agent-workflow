// RFC-341 —— task-lifecycle committed event 的**同步**参与者（dbTxSync 体内用）。
//
// RFC-359：事件形状只有一份，在 `taskLifecycleCommittedEvents.ts`；这里只是把同一份形状交给同步
// 的 `appendCommittedEventTx`。其余 dbTxSync 调用方迁到 `DatabaseSession` 后本文件删除。

import type { DbTxSync } from '@/db/txSync'
import { appendCommittedEventTx } from '@/platform/events/committed/sqliteStore'
import type { CommittedEventRef } from '@/platform/events/committed/types'
import {
  taskCreatedCommittedEventInput,
  taskLifecycleTransitionCommittedEventInput,
  taskNodeStatusesCommittedEventInput,
  type TaskCreatedCommittedEventInput,
  type TaskLifecycleTransitionCommittedEventInput,
  type TaskNodeStatusesCommittedEventInput,
} from './taskLifecycleCommittedEvents'

export type { TaskCommittedEventIdentity } from './taskLifecycleCommittedEvents'

export function appendTaskCreatedCommittedEventTx(
  tx: DbTxSync,
  input: TaskCreatedCommittedEventInput,
): CommittedEventRef | null {
  return appendCommittedEventTx(tx, taskCreatedCommittedEventInput(input)).eventRef
}

export function appendTaskLifecycleTransitionCommittedEventTx(
  tx: DbTxSync,
  input: TaskLifecycleTransitionCommittedEventInput,
): CommittedEventRef | null {
  return appendCommittedEventTx(tx, taskLifecycleTransitionCommittedEventInput(input)).eventRef
}

export function appendTaskNodeStatusesCommittedEventTx(
  tx: DbTxSync,
  input: TaskNodeStatusesCommittedEventInput & {
    readonly reason: TaskNodeStatusesCommittedEventInput['reason']
  },
): CommittedEventRef | null {
  return appendCommittedEventTx(tx, taskNodeStatusesCommittedEventInput(input)).eventRef
}
