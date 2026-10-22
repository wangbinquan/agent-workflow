// One transaction-local sequence; the original entry points retain their
// synchronous or asynchronous execution and affected-row contracts.
import { tablesOf } from '@/platform/persistence/sessionTables'
import { queryRows, queryWrite } from '@/platform/persistence/queryHelpers'
import { and, eq, inArray } from 'drizzle-orm'

import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import {
  transactionStep,
  type TransactionProgramStep,
} from '@/platform/persistence/transactionProgram'
import { TaskExecutionError } from '../application/taskExecutionError'
import type { TerminalizeTaskExecutionIntentsInput } from '../application/terminalizeExecutionIntent'

export function* taskExecutionIntentTerminalSequence<Tx extends PersistenceDb>(
  tx: Tx,
  input: TerminalizeTaskExecutionIntentsInput,
  writeChecks: 'unchecked' | 'require-returned-rows',
): Generator<TransactionProgramStep, void, void> {
  const active = yield* transactionStep(() => {
    const { taskExecutionIntents } = tablesOf(tx)
    return queryRows(
      tx
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
        ),
    )
  })
  const activeIntentIds = active.map((row) => row.id)
  if (activeIntentIds.length === 0) return
  const { taskExecutionIntents, taskExecutionLineageOperationRecords } = tablesOf(tx)
  const terminalize = tx
    .update(taskExecutionIntents)
    .set({
      state: input.state,
      failureCode: input.failureCode,
      completedAt: input.now,
      updatedAt: input.now,
    })
    .where(inArray(taskExecutionIntents.id, activeIntentIds))
  if (writeChecks === 'require-returned-rows') {
    const terminalized = yield* transactionStep(() => {
      return queryRows(terminalize.returning({ id: taskExecutionIntents.id }))
    })
    if (terminalized.length !== activeIntentIds.length) {
      throw new TaskExecutionError(
        'task-continuation-stale',
        `task '${input.taskId}' active intents changed during terminalization`,
      )
    }
  } else {
    yield* transactionStep(() => queryWrite(terminalize))
  }
  const decisions = yield* transactionStep(() => {
    return queryRows(
      tx
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
        ),
    )
  })
  for (const decision of decisions) {
    const release = tx
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
    if (writeChecks === 'require-returned-rows') {
      const released = yield* transactionStep(() => {
        return queryRows(release.returning({ id: taskExecutionLineageOperationRecords.id }))
      })
      if (released[0] === undefined) {
        throw new TaskExecutionError(
          'task-continuation-stale',
          `replay decision '${decision.id}' changed during intent terminalization`,
        )
      }
    } else {
      yield* transactionStep(() => queryWrite(release))
    }
  }
}
