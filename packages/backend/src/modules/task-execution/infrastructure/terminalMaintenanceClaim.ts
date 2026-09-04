// RFC-359 W1-T7c —— 终态维护认领（RFC-328 terminal maintenance claim）事务内 CAS 的**一份**实现。
//
// 此前只有 SQLite 同步 store（`sqliteTerminalMaintenance.ts` 的 `assertClaimTx` / `transitionTx`，
// dbTxSync）带事务内参与者；PostgreSQL 适配器只有整笔 `transition`，没有能挂进调用方事务的原子——
// 任何「先验认领、再改业务行、再推进认领」的原子（删除恢复、归档……）在 PG 上都拼不出来。
// 这里按 `DatabaseTransaction` 写一次：同一张状态转移表、同一个 revision / memberSetDigest 围栏。

import { and, eq, isNull } from 'drizzle-orm'

import { taskExecutionMaintenanceClaims, taskExecutionMaintenanceMembers } from '@/db/schema'
import { affectedRows, type DatabaseTransaction } from '@/platform/persistence/databaseTransaction'
import { TaskExecutionError } from '../application/taskExecutionError'
import {
  assertTerminalMaintenanceClaim,
  createTerminalMaintenanceClaim,
  type TerminalMaintenanceClaim,
} from '../domain/ownership'
import {
  assertMaintenanceTransition,
  type TerminalMaintenanceState,
} from '../domain/terminalMaintenance'

/** 认领行必须仍是这把 capability 描述的那一行，且处在调用方预期的状态。 */
export async function assertTerminalMaintenanceClaimTx(
  tx: DatabaseTransaction,
  input: {
    readonly claim: TerminalMaintenanceClaim
    readonly expectedState: TerminalMaintenanceState
  },
): Promise<void> {
  assertTerminalMaintenanceClaim(input.claim)
  const row = (
    await tx
      .select()
      .from(taskExecutionMaintenanceClaims)
      .where(eq(taskExecutionMaintenanceClaims.id, input.claim.claimId))
      .limit(1)
  )[0]
  if (
    row === undefined ||
    row.operation !== input.claim.operation ||
    row.memberSetDigest !== input.claim.memberSetDigest ||
    row.revision !== input.claim.revision ||
    row.state !== input.expectedState
  ) {
    throw new TaskExecutionError(
      'task-terminal-maintenance-conflict',
      `terminal maintenance claim '${input.claim.claimId}' changed`,
    )
  }
}

/** 按转移表推进认领；`completed` 或显式 `releaseMembers` 时释放成员行的活动占位。 */
export async function transitionTerminalMaintenanceClaimTx(
  tx: DatabaseTransaction,
  input: {
    readonly claim: TerminalMaintenanceClaim
    readonly to: TerminalMaintenanceState
    readonly now: number
    readonly releaseMembers?: boolean
  },
): Promise<TerminalMaintenanceClaim> {
  const row = (
    await tx
      .select({ state: taskExecutionMaintenanceClaims.state })
      .from(taskExecutionMaintenanceClaims)
      .where(eq(taskExecutionMaintenanceClaims.id, input.claim.claimId))
      .limit(1)
  )[0]
  if (row === undefined) {
    throw new TaskExecutionError(
      'task-terminal-maintenance-conflict',
      `terminal maintenance claim '${input.claim.claimId}' does not exist`,
    )
  }
  await assertTerminalMaintenanceClaimTx(tx, { claim: input.claim, expectedState: row.state })
  assertMaintenanceTransition(row.state, input.to)
  const nextRevision = input.claim.revision + 1
  const updated = await tx
    .update(taskExecutionMaintenanceClaims)
    .set({
      state: input.to,
      revision: nextRevision,
      updatedAt: input.now,
      completedAt: input.to === 'completed' ? input.now : null,
    })
    .where(
      and(
        eq(taskExecutionMaintenanceClaims.id, input.claim.claimId),
        eq(taskExecutionMaintenanceClaims.revision, input.claim.revision),
        eq(taskExecutionMaintenanceClaims.state, row.state),
      ),
    )
    .run()
  if (affectedRows(updated) !== 1) {
    throw new TaskExecutionError(
      'task-terminal-maintenance-conflict',
      `terminal maintenance claim '${input.claim.claimId}' transition lost`,
    )
  }
  if (input.releaseMembers === true || input.to === 'completed') {
    await tx
      .update(taskExecutionMaintenanceMembers)
      .set({ releasedAt: input.now })
      .where(
        and(
          eq(taskExecutionMaintenanceMembers.claimId, input.claim.claimId),
          isNull(taskExecutionMaintenanceMembers.releasedAt),
        ),
      )
      .run()
  }
  return createTerminalMaintenanceClaim({
    claimId: input.claim.claimId,
    operation: input.claim.operation,
    revision: nextRevision,
    memberSetDigest: input.claim.memberSetDigest,
  })
}
