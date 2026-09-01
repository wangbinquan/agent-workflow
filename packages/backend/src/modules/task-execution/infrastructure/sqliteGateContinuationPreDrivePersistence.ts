import { and, eq, isNotNull, isNull } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { taskExecutionIntents, taskQuestions } from '@/db/schema'
import { decodeClaimedClarifyContinuation } from '../application/claimedClarifyContinuation'
import type { GateContinuationPreDrivePersistence } from '../application/ports/gateContinuationPreDrivePersistence'
import { TaskExecutionError } from '../application/taskExecutionError'
import { isLegacyTaskGateContinuationPayload } from '../domain/humanGateContinuation'
import { SqliteTaskOwnershipStore } from './sqliteTaskOwnership'

export class SqliteGateContinuationPreDrivePersistence implements GateContinuationPreDrivePersistence {
  private readonly ownership = new SqliteTaskOwnershipStore()

  constructor(private readonly db: DbClient) {}

  async inspect(input: Parameters<GateContinuationPreDrivePersistence['inspect']>[0]) {
    const intent = this.db
      .select({
        kind: taskExecutionIntents.kind,
        state: taskExecutionIntents.state,
        claimedEpoch: taskExecutionIntents.claimedEpoch,
        payloadJson: taskExecutionIntents.payloadJson,
      })
      .from(taskExecutionIntents)
      .where(
        and(
          eq(taskExecutionIntents.id, input.intentId),
          eq(taskExecutionIntents.taskId, input.taskId),
        ),
      )
      .get()
    if (
      intent === undefined ||
      intent.state !== 'claimed' ||
      intent.claimedEpoch !== input.token.epoch
    ) {
      throw new TaskExecutionError(
        'task-execution-stale-owner',
        `clarify convergence cannot read exact claimed intent '${input.intentId}'`,
      )
    }
    if (
      intent.kind !== 'gate-continuation' ||
      isLegacyTaskGateContinuationPayload(intent.payloadJson)
    ) {
      return { kind: 'ready' as const }
    }
    const continuation = decodeClaimedClarifyContinuation(intent.payloadJson)
    return continuation === null
      ? { kind: 'ready' as const }
      : { kind: 'clarify' as const, continuation }
  }

  async hasUndispatchedClarifyWork(
    input: Parameters<GateContinuationPreDrivePersistence['hasUndispatchedClarifyWork']>[0],
  ): Promise<boolean> {
    return (
      this.db
        .select({ id: taskQuestions.id })
        .from(taskQuestions)
        .where(
          and(
            eq(taskQuestions.taskId, input.taskId),
            eq(taskQuestions.originNodeRunId, input.originNodeRunId),
            eq(taskQuestions.confirmation, 'open'),
            isNotNull(taskQuestions.sealedAt),
            isNull(taskQuestions.dispatchedAt),
          ),
        )
        .get() !== undefined
    )
  }

  async releaseClarifyForRetry(
    input: Parameters<GateContinuationPreDrivePersistence['releaseClarifyForRetry']>[0],
  ): Promise<void> {
    this.ownership.withOwnedTaskTx({
      db: this.db,
      token: input.token,
      now: input.now,
      run: (tx) => {
        const released = tx
          .update(taskExecutionIntents)
          .set({
            state: 'pending',
            claimedEpoch: null,
            claimedAt: null,
            failureCode: 'clarify-convergence-retry',
            updatedAt: input.now,
          })
          .where(
            and(
              eq(taskExecutionIntents.id, input.intentId),
              eq(taskExecutionIntents.taskId, input.taskId),
              eq(taskExecutionIntents.kind, 'gate-continuation'),
              eq(taskExecutionIntents.state, 'claimed'),
              eq(taskExecutionIntents.claimedEpoch, input.token.epoch),
            ),
          )
          .returning({ id: taskExecutionIntents.id })
          .get()
        if (released === undefined) {
          throw new TaskExecutionError(
            'task-execution-stale-owner',
            `clarify convergence could not release exact intent '${input.intentId}' for retry`,
          )
        }
      },
    })
  }
}
