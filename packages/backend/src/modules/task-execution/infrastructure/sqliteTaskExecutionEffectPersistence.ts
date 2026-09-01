// RFC-349 — Promise adapter over the proven RFC-328 SQLite effect journal.

import { and, eq, inArray } from '@/db/query'
import type { DbClient } from '@/db/client'
import {
  nodeRunOutputs,
  nodeRuns,
  taskExecutionEffectAttempts,
  taskExecutionEffects,
  taskExecutionIntents,
  tasks,
} from '@/db/schema'
import { setNodeRunStatusTx } from '@/services/lifecycle'
import type { TaskExecutionEffectPersistence } from '../application/ports/taskExecutionEffectStore'
import type { GateContinuationEffectPersistence } from '../application/drive/gateContinuationEffectStep'
import { TaskExecutionError } from '../application/taskExecutionError'
import { SqliteTaskExecutionEffectStore } from './sqliteTaskExecutionEffect'
import { SqliteTaskOwnershipStore } from './sqliteTaskOwnership'

export class SqliteTaskExecutionEffectPersistence implements TaskExecutionEffectPersistence {
  private readonly ownership = new SqliteTaskOwnershipStore()
  private readonly effects = new SqliteTaskExecutionEffectStore(this.ownership)

  constructor(private readonly db: DbClient) {}

  async readLineage(input: Parameters<TaskExecutionEffectPersistence['readLineage']>[0]) {
    const task = this.db
      .select({
        executionLineageId: tasks.executionLineageId,
        lineageSlotPathJson: tasks.lineageSlotPathJson,
        workflowVersion: tasks.workflowVersion,
      })
      .from(tasks)
      .where(eq(tasks.id, input.taskId))
      .get()
    const intent = this.db
      .select({
        executionLineageId: taskExecutionIntents.executionLineageId,
        continuationSlotKey: taskExecutionIntents.continuationSlotKey,
        slotPathJson: taskExecutionIntents.slotPathJson,
      })
      .from(taskExecutionIntents)
      .where(
        and(
          eq(taskExecutionIntents.id, input.intentId),
          eq(taskExecutionIntents.taskId, input.taskId),
        ),
      )
      .get()
    const run =
      input.nodeRunId === undefined
        ? undefined
        : this.db
            .select({
              nodeId: nodeRuns.nodeId,
              iteration: nodeRuns.iteration,
              retryIndex: nodeRuns.retryIndex,
              shardKey: nodeRuns.shardKey,
              continuationSlotKey: nodeRuns.continuationSlotKey,
              lineageSlotPathJson: nodeRuns.lineageSlotPathJson,
            })
            .from(nodeRuns)
            .where(and(eq(nodeRuns.id, input.nodeRunId), eq(nodeRuns.taskId, input.taskId)))
            .get()
    if (
      task === undefined ||
      intent === undefined ||
      (input.nodeRunId !== undefined && run === undefined)
    ) {
      return null
    }
    return {
      executionLineageId: task.executionLineageId ?? intent.executionLineageId,
      continuationSlotKey: run?.continuationSlotKey ?? intent.continuationSlotKey,
      slotPathJson:
        run?.lineageSlotPathJson ?? intent.slotPathJson ?? task.lineageSlotPathJson ?? '[]',
      workflowVersion: task.workflowVersion,
      nodeId: run?.nodeId ?? null,
      iteration: run?.iteration ?? null,
      retryIndex: run?.retryIndex ?? null,
      shardKey: run?.shardKey ?? null,
    }
  }

  async planCodeHostAttempt(
    input: Parameters<TaskExecutionEffectPersistence['planCodeHostAttempt']>[0],
  ) {
    return this.effects.planCodeHostAttempt({ db: this.db, ...input })
  }

  async nextOperationGeneration(
    input: Parameters<TaskExecutionEffectPersistence['nextOperationGeneration']>[0],
  ) {
    return this.effects.nextOperationGeneration({ db: this.db, ...input })
  }

  async prepareAndAcquire(
    input: Parameters<TaskExecutionEffectPersistence['prepareAndAcquire']>[0],
  ) {
    return this.effects.prepareAndAcquire({ db: this.db, ...input })
  }

  async settle(input: Parameters<TaskExecutionEffectPersistence['settle']>[0]): Promise<void> {
    this.effects.settle({ db: this.db, ...input })
  }

  /** Use-case-specific atom: effect settlement and review rollback projection
   * share the same SQLite transaction. Kept off the generic effect port. */
  async settleGateRollback(
    input: Parameters<GateContinuationEffectPersistence['settle']>[0],
  ): Promise<void> {
    if (input.outcome.kind === 'threw') {
      this.effects.settle({
        db: this.db,
        token: input.token,
        effectId: input.effectId,
        attemptId: input.attemptId,
        state: 'recovery-required',
        applicationEvidence: 'ambiguous',
        retryAuthority: 'none',
        receiptJson: JSON.stringify({
          v: 1,
          operationId: input.operationId,
          planDigest: input.planDigest,
          error: input.outcome.error,
        }),
        failureCode: 'human-gate-workspace-rollback-threw',
      })
      return
    }
    const outcome = input.outcome
    this.effects.settle({
      db: this.db,
      token: input.token,
      effectId: input.effectId,
      attemptId: input.attemptId,
      state: outcome.applicationEvidence === 'applied' ? 'succeeded' : 'failed-not-applied',
      applicationEvidence: outcome.applicationEvidence,
      retryAuthority: 'none',
      receiptJson: JSON.stringify({
        v: 1,
        operationId: input.operationId,
        planDigest: input.planDigest,
        rolledBack: outcome.rolledBack,
        outcome: outcome.receipt,
      }),
      ...(outcome.rolledBack ? {} : { failureCode: 'human-gate-workspace-rollback-incomplete' }),
      onSettledTx: (tx) => {
        if (input.sourceNodeRunIds.length === 0) return
        const rows = tx
          .select({ id: nodeRuns.id, errorMessage: nodeRuns.errorMessage })
          .from(nodeRuns)
          .where(
            and(
              eq(nodeRuns.taskId, input.token.taskId),
              inArray(nodeRuns.id, [...input.sourceNodeRunIds]),
            ),
          )
          .limit(input.sourceNodeRunIds.length)
          .all()
        if (rows.length !== input.sourceNodeRunIds.length) {
          throw new TaskExecutionError(
            'task-continuation-stale',
            `workspace rollback projection for '${input.operationId}' lost a source row`,
          )
        }
        const successful = new Set(outcome.successfulSourceNodeRunIds)
        for (const row of rows) {
          const rolledBack = successful.has(row.id)
          tx.update(nodeRuns)
            .set({
              rolledBack,
              errorMessage:
                row.errorMessage === null
                  ? null
                  : row.errorMessage.replace(
                      /^(superseded-by-review-(?:rejected|iterated))(?:-rollback)?:/,
                      `$1${rolledBack ? '-rollback' : ''}:`,
                    ),
            })
            .where(and(eq(nodeRuns.id, row.id), eq(nodeRuns.taskId, input.token.taskId)))
            .run()
        }
      },
    })
  }

  async settleCodeHostNode(
    input: Parameters<TaskExecutionEffectPersistence['settleCodeHostNode']>[0],
  ): Promise<void> {
    this.effects.settle({
      db: this.db,
      ...input.settlement,
      onSettledTx: (tx) => {
        for (const output of input.projection.outputs ?? []) {
          tx.insert(nodeRunOutputs)
            .values({ nodeRunId: input.projection.nodeRunId, ...output })
            .onConflictDoUpdate({
              target: [nodeRunOutputs.nodeRunId, nodeRunOutputs.portName],
              set: { content: output.content },
            })
            .run()
        }
        setNodeRunStatusTx({
          tx,
          nodeRunId: input.projection.nodeRunId,
          to: input.projection.status,
          allowedFrom: ['running'],
          reason: input.projection.reason,
          extra: {
            finishedAt: input.projection.finishedAt,
            ...(input.projection.errorMessage === undefined
              ? {}
              : { errorMessage: input.projection.errorMessage }),
            ...(input.projection.failureCode === undefined
              ? {}
              : { failureCode: input.projection.failureCode }),
          },
        })
      },
    })
  }

  async recordProcessSpawn(
    input: Parameters<TaskExecutionEffectPersistence['recordProcessSpawn']>[0],
  ): Promise<void> {
    const now = input.now ?? Date.now()
    this.ownership.withOwnedTaskTx({
      db: this.db,
      token: input.token,
      now,
      run: (tx) => {
        const attempt = tx
          .select({
            state: taskExecutionEffectAttempts.state,
            epoch: taskExecutionEffectAttempts.epoch,
            effectTaskId: taskExecutionEffects.taskId,
          })
          .from(taskExecutionEffectAttempts)
          .innerJoin(
            taskExecutionEffects,
            eq(taskExecutionEffects.id, taskExecutionEffectAttempts.effectId),
          )
          .where(
            and(
              eq(taskExecutionEffectAttempts.id, input.attemptId),
              eq(taskExecutionEffectAttempts.effectId, input.effectId),
            ),
          )
          .get()
        if (
          attempt === undefined ||
          attempt.state !== 'acting' ||
          attempt.epoch !== input.token.epoch ||
          attempt.effectTaskId !== input.token.taskId
        ) {
          throw new TaskExecutionError(
            'task-execution-stale-owner',
            `process attempt '${input.attemptId}' receipt was fenced`,
          )
        }
        const receiptJson = JSON.stringify({
          v: 1,
          phase: 'spawn-receipt',
          pid: input.pid,
          spawnBinaryPath: input.spawnBinaryPath,
          launchNonce: input.launchNonce,
        })
        const updated = tx
          .update(taskExecutionEffectAttempts)
          .set({ receiptJson, updatedAt: now })
          .where(
            and(
              eq(taskExecutionEffectAttempts.id, input.attemptId),
              eq(taskExecutionEffectAttempts.state, 'acting'),
              eq(taskExecutionEffectAttempts.epoch, input.token.epoch),
            ),
          )
          .returning({ id: taskExecutionEffectAttempts.id })
          .get()
        if (updated === undefined) {
          throw new TaskExecutionError(
            'task-execution-stale-owner',
            `process attempt '${input.attemptId}' receipt update lost`,
          )
        }
        tx.update(nodeRuns)
          .set({
            pid: input.pid,
            spawnBinaryPath: input.spawnBinaryPath,
            spawnLaunchNonce: input.launchNonce,
            ...(input.runtimeParamsJson === undefined
              ? {}
              : { runtimeParamsJson: input.runtimeParamsJson }),
          })
          .where(and(eq(nodeRuns.id, input.nodeRunId), eq(nodeRuns.taskId, input.token.taskId)))
          .run()
      },
    })
  }
}
