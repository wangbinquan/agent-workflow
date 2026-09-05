// RFC-359 W4-B1 批 2g —— 执行 intent 终态化 + replay 授权释放：一份实现，两个 provider 共用。
// 同步的 `sqliteTerminalizeExecutionIntent.ts`（dbTxSync 形态）暂留给尚未迁移的 legacy 同步调用方。

import { and, eq, inArray } from 'drizzle-orm'

import { taskExecutionIntents, taskExecutionLineageOperationRecords } from '@/db/schema'
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  databaseSessionFor,
  type DatabaseTransaction,
} from '@/platform/persistence/databaseTransaction'
import type { TaskExecutionIntentTerminalPersistence } from '../application/terminalizeExecutionIntent'
import { TaskExecutionError } from '../application/taskExecutionError'

export class DrizzleTaskExecutionIntentTerminalPersistence implements TaskExecutionIntentTerminalPersistence {
  constructor(private readonly db: ProviderNeutralDatabase) {}

  async terminalize(
    input: Parameters<TaskExecutionIntentTerminalPersistence['terminalize']>[0],
  ): Promise<void> {
    // intents 有跨行不变量（每任务至多一个 pending / claimed 的部分唯一索引 + replay 决定的释放），沿用 SERIALIZABLE。
    await databaseSessionFor(this.db).serializable(async (tx) => {
      await terminalizeTaskExecutionIntentsInTx(tx, input)
    })
  }
}

/** 事务内参与者，供更大的原子（恢复、源终止、人工门决定）在自己的事务里调用。 */
export async function terminalizeTaskExecutionIntentsInTx(
  tx: DatabaseTransaction,
  input: Parameters<TaskExecutionIntentTerminalPersistence['terminalize']>[0],
): Promise<void> {
  const active = await tx
    .select({ id: taskExecutionIntents.id })
    .from(taskExecutionIntents)
    .where(
      and(
        eq(taskExecutionIntents.taskId, input.taskId),
        input.claimedOwnerEpoch === undefined
          ? inArray(taskExecutionIntents.state, ['pending', 'claimed'])
          : and(
              eq(taskExecutionIntents.state, 'claimed'),
              eq(taskExecutionIntents.claimedEpoch, input.claimedOwnerEpoch),
            ),
      ),
    )
  const activeIntentIds = active.map((row) => row.id)
  if (activeIntentIds.length === 0) return
  const terminalized = await tx
    .update(taskExecutionIntents)
    .set({
      state: input.state,
      failureCode: input.failureCode,
      completedAt: input.now,
      updatedAt: input.now,
    })
    .where(inArray(taskExecutionIntents.id, activeIntentIds))
    .returning({ id: taskExecutionIntents.id })
  if (terminalized.length !== activeIntentIds.length) {
    throw new TaskExecutionError(
      'task-continuation-stale',
      `task '${input.taskId}' active intents changed during terminalization`,
    )
  }
  const decisions = await tx
    .select({
      id: taskExecutionLineageOperationRecords.id,
      revision: taskExecutionLineageOperationRecords.recordRevision,
    })
    .from(taskExecutionLineageOperationRecords)
    .where(
      and(
        eq(taskExecutionLineageOperationRecords.recordKind, 'replay-decision'),
        eq(taskExecutionLineageOperationRecords.decisionState, 'actor-replay-authorized'),
        inArray(taskExecutionLineageOperationRecords.boundIntentId, activeIntentIds),
      ),
    )
  for (const decision of decisions) {
    const released = await tx
      .update(taskExecutionLineageOperationRecords)
      .set({
        decisionState: 'requires-actor',
        replayAuthorizationId: null,
        authorizationScopeJson: null,
        actorUserId: null,
        authorizationSource: null,
        boundIntentId: null,
        recordRevision: decision.revision + 1,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(taskExecutionLineageOperationRecords.id, decision.id),
          eq(taskExecutionLineageOperationRecords.recordRevision, decision.revision),
          eq(taskExecutionLineageOperationRecords.decisionState, 'actor-replay-authorized'),
        ),
      )
      .returning({ id: taskExecutionLineageOperationRecords.id })
    if (released[0] === undefined) {
      throw new TaskExecutionError(
        'task-continuation-stale',
        `replay decision '${decision.id}' changed during intent terminalization`,
      )
    }
  }
}
