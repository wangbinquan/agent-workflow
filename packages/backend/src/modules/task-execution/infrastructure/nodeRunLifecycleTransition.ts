// RFC-359 W1-T2c —— node_run 状态 CAS 的**一份**事务内实现，两个引擎共用。
//
// 此前 SQLite 侧是 `platform/persistence/sqlite/taskLifecycle.ts` 的同步
// `setNodeRunStatusTx` / `transitionNodeRunStatusTx`（dbTxSync），PostgreSQL 侧是
// `postgresqlNodeRunLifecyclePersistence.ts` 里另一份 CAS。同一张转移表、同一个 MR/PR 围栏
// 判定、同一个终态覆写闸——这里只写一次：PG participant 的 `set` 委托到这里，SQLite 的同步
// 版本在其余 dbTxSync 调用方迁完前保留（W4 pair-deletion）。不广播：调用方提交后再发。

import {
  isTerminalNodeRunStatus,
  nextNodeRunStatus,
  type NodeRunStatus,
  type NodeRunTransitionEvent,
} from '@agent-workflow/shared'
import { and, eq } from 'drizzle-orm'

import { nodeRuns, tasks } from '@/db/schema'
import type { DatabaseTransaction } from '@/platform/persistence/databaseTransaction'
import {
  ConcurrentNodeRunTransition,
  assertNodeRunSourceTerminationAdmission,
  type NodeRunStatusUpdateExtra,
} from '@/services/lifecycle'
import { ConflictError, NotFoundError } from '@/util/errors'

export interface SetNodeRunStatusTxInput {
  readonly tx: DatabaseTransaction
  readonly nodeRunId: string
  readonly to: NodeRunStatus
  readonly allowedFrom: readonly NodeRunStatus[]
  readonly extra?: NodeRunStatusUpdateExtra
  /** 允许改写终态行（RFC-317 T49 账本逐文件计数 `allowTerminal: true` 站点）。 */
  readonly allowTerminal?: boolean
  /** 只进错误信息的诊断标签。 */
  readonly reason?: string
}

export interface TransitionNodeRunStatusTxInput {
  readonly tx: DatabaseTransaction
  readonly nodeRunId: string
  readonly event: NodeRunTransitionEvent
  readonly extra?: NodeRunStatusUpdateExtra
}

async function currentRow(
  tx: DatabaseTransaction,
  nodeRunId: string,
): Promise<
  Readonly<{
    status: NodeRunStatus
    taskId: string
    sourceTerminationFence: 'closed' | 'merged' | null
  }>
> {
  const row = (
    await tx
      .select({
        status: nodeRuns.status,
        taskId: nodeRuns.taskId,
        sourceTerminationFence: tasks.sourceTerminationFence,
      })
      .from(nodeRuns)
      .innerJoin(tasks, eq(tasks.id, nodeRuns.taskId))
      .where(eq(nodeRuns.id, nodeRunId))
      .limit(1)
  )[0]
  if (row === undefined) {
    throw new NotFoundError('node-run-not-found', `node_run ${nodeRunId} not found`)
  }
  return { ...row, status: row.status as NodeRunStatus }
}

/**
 * 显式 `to` + `allowedFrom` 的事务内 CAS（业务判定不落在事件 ADT 上的站点用它）。
 * 终态行默认拒绝改写；`allowTerminal: true` 的站点由 rfc317-allow-terminal-ledger 逐文件记账。
 */
export async function setNodeRunStatusTx(
  args: SetNodeRunStatusTxInput,
): Promise<{ from: NodeRunStatus; to: NodeRunStatus }> {
  const row = await currentRow(args.tx, args.nodeRunId)
  const from = row.status
  assertNodeRunSourceTerminationAdmission(row.taskId, row.sourceTerminationFence, args.to)
  if (isTerminalNodeRunStatus(from) && args.allowTerminal !== true) {
    throw new ConflictError(
      'illegal-node-run-transition',
      `node_run ${args.nodeRunId} is terminal ('${from}'); refuse to overwrite${args.reason ? ` (${args.reason})` : ''}`,
    )
  }
  if (!args.allowedFrom.includes(from)) {
    throw new ConflictError(
      'illegal-node-run-transition',
      `node_run ${args.nodeRunId} status='${from}' not in allowedFrom=[${args.allowedFrom.join(',')}]${args.reason ? ` (${args.reason})` : ''}`,
    )
  }
  // rfc053-allow-direct-status-write -- RFC-359：两引擎共用的事务内 CAS（setNodeRunStatusTx）
  const updated = await args.tx
    .update(nodeRuns)
    .set({ status: args.to, ...(args.extra ?? {}) })
    .where(and(eq(nodeRuns.id, args.nodeRunId), eq(nodeRuns.status, from)))
    .returning({ id: nodeRuns.id })
  if (updated.length === 0) {
    throw new ConcurrentNodeRunTransition(
      args.nodeRunId,
      from,
      args.reason ?? `setNodeRunStatusTx to=${args.to}`,
    )
  }
  return { from, to: args.to }
}

/** 按具名事件走共享转移表（`nextNodeRunStatus`）的事务内 CAS。 */
export async function transitionNodeRunStatusTx(
  args: TransitionNodeRunStatusTxInput,
): Promise<{ from: NodeRunStatus; to: NodeRunStatus }> {
  const row = await currentRow(args.tx, args.nodeRunId)
  const from = row.status
  const to = nextNodeRunStatus(from, args.event)
  assertNodeRunSourceTerminationAdmission(row.taskId, row.sourceTerminationFence, to)
  // rfc053-allow-direct-status-write -- RFC-359：两引擎共用的事务内 CAS（transitionNodeRunStatusTx）
  const updated = await args.tx
    .update(nodeRuns)
    .set({ status: to, ...(args.extra ?? {}) })
    .where(and(eq(nodeRuns.id, args.nodeRunId), eq(nodeRuns.status, from)))
    .returning({ id: nodeRuns.id })
  if (updated.length === 0) {
    throw new ConcurrentNodeRunTransition(args.nodeRunId, from, args.event.kind)
  }
  return { from, to }
}
