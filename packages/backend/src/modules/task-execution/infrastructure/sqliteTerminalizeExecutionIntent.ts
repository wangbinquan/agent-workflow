// SQLite provider-private transaction participant.
import { and, eq, inArray } from '@/db/query'
import { taskExecutionIntents, taskExecutionLineageOperationRecords } from '@/db/schema'
import type { DbTxSync } from '@/db/txSync'

/**
 * Close active intents for one task and return any unconsumed replay
 * authorization to requires-actor in the same control/recovery transaction.
 * Successor-daemon recovery can fence this to the interrupted claimed epoch so
 * a gate decision committed before the crash keeps its pending successor.
 */
export function terminalizeTaskExecutionIntentsTx(input: {
  tx: DbTxSync
  taskId: string
  state: 'canceled' | 'failed'
  failureCode: string
  now: number
  claimedOwnerEpoch?: number
}): void {
  const activeIntentIds = input.tx
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
    .all()
    .map((row) => row.id)
  if (activeIntentIds.length === 0) return
  input.tx
    .update(taskExecutionIntents)
    .set({
      state: input.state,
      failureCode: input.failureCode,
      completedAt: input.now,
      updatedAt: input.now,
    })
    .where(inArray(taskExecutionIntents.id, activeIntentIds))
    .run()
  const boundDecisions = input.tx
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
    .all()
  for (const decision of boundDecisions) {
    input.tx
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
      .run()
  }
}
