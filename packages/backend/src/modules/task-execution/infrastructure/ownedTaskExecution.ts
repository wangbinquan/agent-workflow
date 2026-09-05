// RFC-359 W4-B1 —— 任务执行写事务 + owner 围栏：一份实现，两个 provider 共用。
//
// 此前 SQLite 走 `sqliteOwnedTaskMutation`（dbTxSync + `withOwnedTaskTx`），PG 走
// `postgresqlTaskLifecycleTransaction`（SERIALIZABLE + `assertPostgresqlTaskOwnerTx`）。这里按统一事务原语
// 重写：`databaseSessionFor(db).transaction`（PG READ COMMITTED——围栏本身是 owner 行上的条件 UPDATE，
// 行锁已把同一任务的写手串起来，不需要 SERIALIZABLE；SQLite BEGIN IMMEDIATE 本就完全串行）。
//
// 围栏选择规则（RFC-359 T7 P0-1 / P0-3 定下的两引擎同一规则）：显式上下文 > 环境上下文 > 无主围栏——
// 有上下文就按 token 做 owner CAS（不做 revision / lease 等值判定，心跳可能已推进它们）；
// 没有上下文就是控制面 / 修复写手，只在任务仍有**活着的**（`claimed`）owner 时拒绝。

import { and, eq, sql } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import { taskExecutionOwners } from '@/db/schema'
import {
  databaseSessionFor,
  type DatabaseTransaction,
} from '@/platform/persistence/databaseTransaction'
import type { TaskExecutionContextRef } from '../application/ports/taskExecutionTopology'
import {
  assertTaskExecutionContext,
  currentTaskExecutionContext,
} from '../application/taskExecutionContext'
import { TaskExecutionError } from '../application/taskExecutionError'
import { assertOwnershipToken, type OwnershipToken } from '../domain/ownership'

export type TaskExecutionTransaction = DatabaseTransaction

/** 任务执行面的写事务：体内抛错整笔回滚；重入复用外层事务。 */
export function withTaskExecutionWrite<T>(
  db: ProviderNeutralDatabase,
  body: (tx: TaskExecutionTransaction) => Promise<T>,
): Promise<T> {
  return databaseSessionFor(db).transaction(body)
}

/** owner CAS 围栏：token 命中 `claimed` 的精确 owner（id + 世代 + epoch）才放行，并推进 revision。 */
export async function assertTaskOwnerTx(
  tx: TaskExecutionTransaction,
  token: OwnershipToken,
  now: number,
): Promise<void> {
  assertOwnershipToken(token)
  const rows = await tx
    .update(taskExecutionOwners)
    .set({
      revision: sql`${taskExecutionOwners.revision} + 1`,
      updatedAt: now,
    })
    .where(
      and(
        eq(taskExecutionOwners.taskId, token.taskId),
        eq(taskExecutionOwners.ownerId, token.ownerId),
        eq(taskExecutionOwners.daemonGeneration, token.daemonGeneration),
        eq(taskExecutionOwners.epoch, token.epoch),
        eq(taskExecutionOwners.state, 'claimed'),
      ),
    )
    .returning({ revision: taskExecutionOwners.revision })
  if (rows[0] === undefined) {
    throw new TaskExecutionError(
      'task-execution-stale-owner',
      `task '${token.taskId}' mutation was fenced`,
    )
  }
}

/** 无主写入围栏：只有活着的 owner（`claimed`）才是必须让路的写手。 */
export async function assertTaskOwnerlessTx(
  tx: TaskExecutionTransaction,
  taskId: string,
): Promise<void> {
  const rows = await tx
    .select({ state: taskExecutionOwners.state })
    .from(taskExecutionOwners)
    .where(eq(taskExecutionOwners.taskId, taskId))
    .limit(1)
  if (rows[0] !== undefined && rows[0].state === 'claimed') {
    throw new TaskExecutionError(
      'task-execution-stale-owner',
      `ownerless task mutation refused durable owner for '${taskId}'`,
    )
  }
}

/** 按「显式上下文 > 环境上下文 > 无主围栏」为一次任务写入选围栏。 */
export async function fenceTaskWrite(
  tx: TaskExecutionTransaction,
  input: {
    readonly taskId: string
    readonly context?: TaskExecutionContextRef | undefined
    readonly now?: number
  },
): Promise<void> {
  const context = input.context ?? currentTaskExecutionContext(input.taskId)
  if (context === undefined) {
    await assertTaskOwnerlessTx(tx, input.taskId)
    return
  }
  assertTaskExecutionContext(context, input.taskId)
  await assertTaskOwnerTx(tx, context.token, input.now ?? Date.now())
}
