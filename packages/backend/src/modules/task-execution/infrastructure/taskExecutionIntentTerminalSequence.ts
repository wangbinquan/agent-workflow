// One transaction-local sequence; the original entry points retain their
// synchronous or asynchronous execution and affected-row contracts.
import { and, eq, inArray } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import { taskExecutionIntents, taskExecutionLineageOperationRecords } from '@/db/schema'
import {
  transactionStep,
  type TransactionProgramStep,
} from '@/platform/persistence/transactionProgram'
import { TaskExecutionError } from '../application/taskExecutionError'
import type { TerminalizeTaskExecutionIntentsInput } from '../application/terminalizeExecutionIntent'

export function* taskExecutionIntentTerminalSequence<Tx extends ProviderNeutralDatabase>(
  tx: Tx,
  input: TerminalizeTaskExecutionIntentsInput,
  writeChecks: 'unchecked' | 'require-returned-rows',
): Generator<TransactionProgramStep, void, void> {
  const active = yield* transactionStep(() =>
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
      )
      .all(),
  )
  const activeIntentIds = active.map((row) => row.id)
  if (activeIntentIds.length === 0) return
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
    const terminalized = yield* transactionStep(() =>
      terminalize.returning({ id: taskExecutionIntents.id }).all(),
    )
    if (terminalized.length !== activeIntentIds.length) {
      throw new TaskExecutionError(
        'task-continuation-stale',
        `task '${input.taskId}' active intents changed during terminalization`,
      )
    }
  } else {
    yield* transactionStep(() => terminalize.run())
  }
  const decisions = yield* transactionStep(() =>
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
      )
      .all(),
  )
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
      const released = yield* transactionStep(() =>
        release.returning({ id: taskExecutionLineageOperationRecords.id }).all(),
      )
      if (released[0] === undefined) {
        throw new TaskExecutionError(
          'task-continuation-stale',
          `replay decision '${decision.id}' changed during intent terminalization`,
        )
      }
    } else {
      yield* transactionStep(() => release.run())
    }
  }
}
