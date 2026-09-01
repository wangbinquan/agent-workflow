import { and, eq, isNotNull, isNull } from 'drizzle-orm'

import { taskExecutionIntents, taskQuestions } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { decodeClaimedClarifyContinuation } from '../application/claimedClarifyContinuation'
import type { GateContinuationPreDrivePersistence } from '../application/ports/gateContinuationPreDrivePersistence'
import { TaskExecutionError } from '../application/taskExecutionError'
import { isLegacyTaskGateContinuationPayload } from '../domain/humanGateContinuation'
import {
  assertPostgresqlTaskOwnerTx,
  withPostgresqlSerializableTaskExecution,
} from './postgresqlTaskLifecycleTransaction'

export class PostgresqlGateContinuationPreDrivePersistence implements GateContinuationPreDrivePersistence {
  constructor(private readonly db: PostgresqlDatabaseClient) {}

  async inspect(input: Parameters<GateContinuationPreDrivePersistence['inspect']>[0]) {
    const rows = await this.db
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
      .limit(1)
    const intent = rows[0]
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
    const rows = await this.db
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
      .limit(1)
    return rows[0] !== undefined
  }

  async releaseClarifyForRetry(
    input: Parameters<GateContinuationPreDrivePersistence['releaseClarifyForRetry']>[0],
  ): Promise<void> {
    await withPostgresqlSerializableTaskExecution(this.db, async (tx) => {
      await assertPostgresqlTaskOwnerTx(tx, input.token, input.now)
      const released = await tx
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
      if (released[0] === undefined) {
        throw new TaskExecutionError(
          'task-execution-stale-owner',
          `clarify convergence could not release exact intent '${input.intentId}' for retry`,
        )
      }
    })
  }
}
