import { and, desc, eq, isNull, max } from 'drizzle-orm'
import { ulid } from 'ulid'
import {
  taskExecutionEffectAttempts,
  taskExecutionEffectFences,
  taskExecutionEffects,
  taskExecutionIntents,
  taskExecutionLineageOperationRecords,
} from '@/db/schema'
import type { DbTxSync } from '@/db/txSync'
import type {
  CodeHostAttemptPlan,
  LinkedWorkspaceRollbackEffect,
  PrepareEffectAttemptInput,
  PreparedEffectAttempt,
  SettleEffectAttemptInput,
  TaskExecutionEffectStore,
} from './taskExecutionEffectTransactionStore'
import type { TaskOwnershipStore } from './taskOwnershipTransactionStore'
import { TaskExecutionError } from '../application/taskExecutionError'
import {
  aggregateEffectOutcome,
  assertAttemptTransition,
  canCreateNextAttempt,
  canonicalResourceKeySet,
  type AttemptEvidence,
} from '../domain/executionEffect'
const MAX_EFFECT_RECEIPT_BYTES = 64 * 1024

function boundedReceipt(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null
  if (Buffer.byteLength(value) > MAX_EFFECT_RECEIPT_BYTES) {
    throw new Error('effect receipt exceeds the internal 64 KiB limit')
  }
  JSON.parse(value)
  return value
}

function isEffectFenceConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    /(?:UNIQUE constraint failed:\s*task_execution_effect_fences\.fence_key|SQLITE_CONSTRAINT_UNIQUE)/i.test(
      error.message,
    )
  )
}

export class SqliteTaskExecutionEffectStore implements TaskExecutionEffectStore {
  constructor(private readonly ownership: TaskOwnershipStore) {}

  linkWorkspaceRollbackTx(input: {
    tx: DbTxSync
    taskId: string
    intentId: string
    operationKey: string
    executionLineageId: string
    operationFamilyKey: string
    operationGeneration: number
    requestHash: string
    slotPathJson: string
    slotPathDigest: string
    now: number
  }): LinkedWorkspaceRollbackEffect {
    const intent = input.tx
      .select({
        taskId: taskExecutionIntents.taskId,
        kind: taskExecutionIntents.kind,
        state: taskExecutionIntents.state,
      })
      .from(taskExecutionIntents)
      .where(eq(taskExecutionIntents.id, input.intentId))
      .get()
    if (
      intent === undefined ||
      intent.taskId !== input.taskId ||
      intent.kind !== 'gate-continuation' ||
      intent.state !== 'pending'
    ) {
      throw new TaskExecutionError(
        'task-continuation-stale',
        `workspace rollback effect requires a pending gate continuation '${input.intentId}'`,
      )
    }
    const existing = input.tx
      .select()
      .from(taskExecutionEffects)
      .where(
        and(
          eq(taskExecutionEffects.currentIntentId, input.intentId),
          eq(taskExecutionEffects.kind, 'workspace-rollback'),
        ),
      )
      .get()
    if (existing !== undefined) {
      if (
        existing.taskId !== input.taskId ||
        existing.operationKey !== input.operationKey ||
        existing.executionLineageId !== input.executionLineageId ||
        existing.operationFamilyKey !== input.operationFamilyKey ||
        existing.operationGeneration !== input.operationGeneration ||
        existing.requestHash !== input.requestHash ||
        existing.slotPathJson !== input.slotPathJson ||
        existing.slotPathDigest !== input.slotPathDigest
      ) {
        throw new TaskExecutionError(
          'task-continuation-conflict',
          `gate continuation '${input.intentId}' is already linked to another rollback effect`,
        )
      }
      return { effectId: existing.id, idempotent: true }
    }
    const effectId = ulid()
    input.tx
      .insert(taskExecutionEffects)
      .values({
        id: effectId,
        taskId: input.taskId,
        originIntentId: input.intentId,
        currentIntentId: input.intentId,
        operationKey: input.operationKey,
        executionLineageId: input.executionLineageId,
        operationFamilyKey: input.operationFamilyKey,
        operationGeneration: input.operationGeneration,
        kind: 'workspace-rollback',
        requestHash: input.requestHash,
        slotPathJson: input.slotPathJson,
        slotPathDigest: input.slotPathDigest,
        state: 'open',
        lastAttemptNo: 0,
        preparedAt: input.now,
        updatedAt: input.now,
      })
      .run()
    return { effectId, idempotent: false }
  }

  planCodeHostAttempt(input: {
    db: Parameters<TaskOwnershipStore['read']>[0]
    executionLineageId: string
    operationFamilyKey: string
  }): CodeHostAttemptPlan {
    const highest = input.db
      .select()
      .from(taskExecutionEffects)
      .where(
        and(
          eq(taskExecutionEffects.executionLineageId, input.executionLineageId),
          eq(taskExecutionEffects.operationFamilyKey, input.operationFamilyKey),
        ),
      )
      .orderBy(desc(taskExecutionEffects.operationGeneration))
      .get()
    if (highest?.state === 'open') {
      const latestAttempt = input.db
        .select({
          state: taskExecutionEffectAttempts.state,
          retryAuthority: taskExecutionEffectAttempts.retryAuthority,
        })
        .from(taskExecutionEffectAttempts)
        .where(eq(taskExecutionEffectAttempts.effectId, highest.id))
        .orderBy(desc(taskExecutionEffectAttempts.attemptNo))
        .get()
      if (latestAttempt?.state === 'retry-authorized' && latestAttempt.retryAuthority !== 'none') {
        return {
          operationGeneration: highest.operationGeneration,
          retryAuthority: latestAttempt.retryAuthority,
        }
      }
    }
    return {
      operationGeneration: this.nextOperationGeneration(input),
      retryAuthority: 'none',
    }
  }

  nextOperationGeneration(input: {
    db: Parameters<TaskOwnershipStore['read']>[0]
    executionLineageId: string
    operationFamilyKey: string
  }): number {
    const liveHighest = input.db
      .select({ generation: max(taskExecutionEffects.operationGeneration) })
      .from(taskExecutionEffects)
      .where(
        and(
          eq(taskExecutionEffects.executionLineageId, input.executionLineageId),
          eq(taskExecutionEffects.operationFamilyKey, input.operationFamilyKey),
        ),
      )
      .get()?.generation
    const watermark = input.db
      .select({ generation: taskExecutionLineageOperationRecords.highestSettledGeneration })
      .from(taskExecutionLineageOperationRecords)
      .where(
        and(
          eq(taskExecutionLineageOperationRecords.recordKind, 'generation-watermark'),
          eq(taskExecutionLineageOperationRecords.executionLineageId, input.executionLineageId),
          eq(taskExecutionLineageOperationRecords.operationFamilyKey, input.operationFamilyKey),
        ),
      )
      .get()?.generation
    return Math.max(liveHighest ?? -1, watermark ?? -1) + 1
  }

  prepareAndAcquire(input: PrepareEffectAttemptInput): PreparedEffectAttempt {
    const now = input.now ?? Date.now()
    const resources = canonicalResourceKeySet(input.resourceKeys)
    const recoveryDescriptor = boundedReceipt(input.recoveryDescriptorJson)
    return this.ownership.withOwnedTaskTx({
      db: input.db,
      token: input.token,
      now,
      run: (tx) => {
        const intent = tx
          .select({
            id: taskExecutionIntents.id,
            taskId: taskExecutionIntents.taskId,
            state: taskExecutionIntents.state,
            claimedEpoch: taskExecutionIntents.claimedEpoch,
            replayAuthorizationId: taskExecutionIntents.replayAuthorizationId,
          })
          .from(taskExecutionIntents)
          .where(eq(taskExecutionIntents.id, input.intentId))
          .get()
        if (
          intent === undefined ||
          intent.taskId !== input.token.taskId ||
          intent.state !== 'claimed' ||
          intent.claimedEpoch !== input.token.epoch
        ) {
          throw new TaskExecutionError(
            'task-execution-stale-owner',
            `intent '${input.intentId}' is not claimed by the current owner epoch`,
          )
        }

        let effect = tx
          .select()
          .from(taskExecutionEffects)
          .where(
            and(
              eq(taskExecutionEffects.executionLineageId, input.executionLineageId),
              eq(taskExecutionEffects.operationFamilyKey, input.operationFamilyKey),
              eq(taskExecutionEffects.operationGeneration, input.operationGeneration),
            ),
          )
          .get()
        if (effect !== undefined) {
          if (
            effect.taskId !== input.token.taskId ||
            effect.operationKey !== input.operationKey ||
            effect.kind !== input.kind ||
            effect.requestHash !== input.requestHash ||
            effect.slotPathDigest !== input.slotPathDigest
          ) {
            throw new TaskExecutionError(
              'task-continuation-conflict',
              'logical effect identity was reused with different immutable input',
            )
          }
          if (effect.state !== 'open') {
            throw new TaskExecutionError(
              effect.state === 'outcome-unknown'
                ? 'task-execution-outcome-unknown'
                : 'task-continuation-conflict',
              `logical effect '${effect.id}' is already ${effect.state}`,
            )
          }
        } else {
          const watermark = tx
            .select({
              id: taskExecutionLineageOperationRecords.id,
              highestSettledGeneration:
                taskExecutionLineageOperationRecords.highestSettledGeneration,
            })
            .from(taskExecutionLineageOperationRecords)
            .where(
              and(
                eq(taskExecutionLineageOperationRecords.recordKind, 'generation-watermark'),
                eq(
                  taskExecutionLineageOperationRecords.executionLineageId,
                  input.executionLineageId,
                ),
                eq(
                  taskExecutionLineageOperationRecords.operationFamilyKey,
                  input.operationFamilyKey,
                ),
              ),
            )
            .get()
          const liveHighest = tx
            .select({ generation: max(taskExecutionEffects.operationGeneration) })
            .from(taskExecutionEffects)
            .where(
              and(
                eq(taskExecutionEffects.executionLineageId, input.executionLineageId),
                eq(taskExecutionEffects.operationFamilyKey, input.operationFamilyKey),
              ),
            )
            .get()?.generation
          const highest = Math.max(watermark?.highestSettledGeneration ?? -1, liveHighest ?? -1)
          if (input.operationGeneration !== highest + 1) {
            throw new TaskExecutionError(
              'task-continuation-stale',
              `operation generation ${input.operationGeneration} is not next after ${highest}`,
            )
          }
          const predecessorDecision = tx
            .select()
            .from(taskExecutionLineageOperationRecords)
            .where(
              and(
                eq(taskExecutionLineageOperationRecords.recordKind, 'replay-decision'),
                eq(
                  taskExecutionLineageOperationRecords.executionLineageId,
                  input.executionLineageId,
                ),
                eq(
                  taskExecutionLineageOperationRecords.operationFamilyKey,
                  input.operationFamilyKey,
                ),
                eq(
                  taskExecutionLineageOperationRecords.operationGeneration,
                  input.operationGeneration - 1,
                ),
              ),
            )
            .get()
          if (predecessorDecision !== undefined) {
            if (
              predecessorDecision.decisionState !== 'actor-replay-authorized' ||
              predecessorDecision.replayAuthorizationId !== intent.replayAuthorizationId ||
              predecessorDecision.boundIntentId !== intent.id
            ) {
              throw new TaskExecutionError(
                'task-execution-outcome-unknown',
                'the prior unknown operation has no matching actor replay authorization',
              )
            }
          }

          const effectId = ulid()
          tx.insert(taskExecutionEffects)
            .values({
              id: effectId,
              taskId: input.token.taskId,
              originIntentId: input.intentId,
              currentIntentId: input.intentId,
              operationKey: input.operationKey,
              executionLineageId: input.executionLineageId,
              operationFamilyKey: input.operationFamilyKey,
              operationGeneration: input.operationGeneration,
              kind: input.kind,
              requestHash: input.requestHash,
              slotPathJson: input.slotPathJson,
              slotPathDigest: input.slotPathDigest,
              state: 'open',
              lastAttemptNo: 0,
              preparedAt: now,
              updatedAt: now,
            })
            .run()
          effect = tx
            .select()
            .from(taskExecutionEffects)
            .where(eq(taskExecutionEffects.id, effectId))
            .get()
          if (effect === undefined) throw new Error('effect insert did not materialize')
          if (predecessorDecision !== undefined) {
            tx.update(taskExecutionLineageOperationRecords)
              .set({
                decisionState: 'consumed',
                boundIntentId: null,
                newEffectId: effectId,
                recordRevision: predecessorDecision.recordRevision + 1,
                updatedAt: now,
              })
              .where(
                and(
                  eq(taskExecutionLineageOperationRecords.id, predecessorDecision.id),
                  eq(
                    taskExecutionLineageOperationRecords.recordRevision,
                    predecessorDecision.recordRevision,
                  ),
                  eq(taskExecutionLineageOperationRecords.decisionState, 'actor-replay-authorized'),
                ),
              )
              .run()
          }
        }

        const priorAttempts = tx
          .select({
            attemptNo: taskExecutionEffectAttempts.attemptNo,
            state: taskExecutionEffectAttempts.state,
            applicationEvidence: taskExecutionEffectAttempts.applicationEvidence,
            retryAuthority: taskExecutionEffectAttempts.retryAuthority,
          })
          .from(taskExecutionEffectAttempts)
          .where(eq(taskExecutionEffectAttempts.effectId, effect.id))
          .orderBy(taskExecutionEffectAttempts.attemptNo)
          .all()
        const attemptNo = priorAttempts.length + 1
        if (priorAttempts.some((attempt, index) => attempt.attemptNo !== index + 1)) {
          throw new Error('non-monotonic persisted effect attempts')
        }
        const previous = priorAttempts[priorAttempts.length - 1]
        if (
          previous !== undefined &&
          !canCreateNextAttempt({
            previous: {
              attemptNo: previous.attemptNo,
              state: previous.state,
              applicationEvidence: previous.applicationEvidence ?? 'ambiguous',
            },
            retryAuthority: input.retryAuthority,
          })
        ) {
          throw new TaskExecutionError(
            'task-continuation-conflict',
            `effect '${effect.id}' does not permit attempt ${attemptNo}`,
          )
        }

        const attemptId = ulid()
        tx.insert(taskExecutionEffectAttempts)
          .values({
            id: attemptId,
            effectId: effect.id,
            attemptNo,
            intentId: input.intentId,
            epoch: input.token.epoch,
            state: 'prepared',
            candidateId: input.candidateId,
            requestHash: input.requestHash,
            recoveryClass: input.recoveryClass,
            recoveryDescriptorJson: recoveryDescriptor,
            classifierVersion: input.classifierVersion,
            transportPolicyVersion: input.transportPolicyVersion,
            retryAuthority: input.retryAuthority,
            preparedAt: now,
            updatedAt: now,
          })
          .run()
        for (const resourceKey of resources) {
          try {
            tx.insert(taskExecutionEffectFences)
              .values({
                effectAttemptId: attemptId,
                fenceKey: resourceKey,
                acquiredEpoch: input.token.epoch,
                acquiredAt: now,
              })
              .run()
          } catch (error) {
            if (!isEffectFenceConflict(error)) throw error
            throw new TaskExecutionError(
              'task-execution-resource-conflict',
              `resource '${resourceKey}' is already held by another acting effect`,
              { resourceKey },
            )
          }
        }
        tx.update(taskExecutionEffectAttempts)
          .set({ state: 'acting', actingAt: now, updatedAt: now })
          .where(
            and(
              eq(taskExecutionEffectAttempts.id, attemptId),
              eq(taskExecutionEffectAttempts.state, 'prepared'),
            ),
          )
          .run()
        tx.update(taskExecutionEffects)
          .set({
            lastAttemptNo: attemptNo,
            currentIntentId: input.intentId,
            updatedAt: now,
          })
          .where(
            and(
              eq(taskExecutionEffects.id, effect.id),
              eq(taskExecutionEffects.state, 'open'),
              eq(taskExecutionEffects.lastAttemptNo, attemptNo - 1),
            ),
          )
          .run()
        return { effectId: effect.id, attemptId, attemptNo, resourceKeys: resources }
      },
    })
  }

  settle(input: SettleEffectAttemptInput): void {
    if (input.state === 'outcome-unknown') {
      throw new TaskExecutionError(
        'task-execution-recovery-required',
        'outcome-unknown requires a task-wide quiescence closure; ordinary worker settlement may only mark recovery-required',
      )
    }
    const now = input.now ?? Date.now()
    const receipt = boundedReceipt(input.receiptJson)
    this.ownership.withOwnedTaskTx({
      db: input.db,
      token: input.token,
      now,
      run: (tx) => {
        const attempt = tx
          .select()
          .from(taskExecutionEffectAttempts)
          .where(eq(taskExecutionEffectAttempts.id, input.attemptId))
          .get()
        const effect = tx
          .select()
          .from(taskExecutionEffects)
          .where(eq(taskExecutionEffects.id, input.effectId))
          .get()
        if (
          attempt === undefined ||
          effect === undefined ||
          attempt.effectId !== effect.id ||
          effect.taskId !== input.token.taskId ||
          attempt.epoch !== input.token.epoch
        ) {
          throw new TaskExecutionError(
            'task-execution-stale-owner',
            `effect attempt '${input.attemptId}' is not owned by the current epoch`,
          )
        }
        assertAttemptTransition(attempt.state, input.state)
        tx.update(taskExecutionEffectAttempts)
          .set({
            state: input.state,
            applicationEvidence: input.applicationEvidence,
            retryAuthority: input.retryAuthority,
            receiptJson: receipt,
            failureCode: input.failureCode ?? null,
            settledAt:
              input.state === 'recovery-required' || input.state === 'retry-authorized'
                ? null
                : now,
            updatedAt: now,
          })
          .where(
            and(
              eq(taskExecutionEffectAttempts.id, attempt.id),
              eq(taskExecutionEffectAttempts.state, attempt.state),
              eq(taskExecutionEffectAttempts.epoch, input.token.epoch),
            ),
          )
          .run()

        if (input.state === 'retry-authorized') {
          // A policy-approved next send no longer needs this attempt's hold.
          tx.update(taskExecutionEffectFences)
            .set({ releasedAt: now })
            .where(
              and(
                eq(taskExecutionEffectFences.effectAttemptId, attempt.id),
                isNull(taskExecutionEffectFences.releasedAt),
                eq(taskExecutionEffectFences.acquiredEpoch, input.token.epoch),
              ),
            )
            .run()
          input.onSettledTx?.(tx)
          return
        }
        if (input.state === 'recovery-required') {
          input.onSettledTx?.(tx)
          return
        }

        const attempts = tx
          .select({
            attemptNo: taskExecutionEffectAttempts.attemptNo,
            state: taskExecutionEffectAttempts.state,
            applicationEvidence: taskExecutionEffectAttempts.applicationEvidence,
          })
          .from(taskExecutionEffectAttempts)
          .where(eq(taskExecutionEffectAttempts.effectId, effect.id))
          .orderBy(taskExecutionEffectAttempts.attemptNo)
          .all()
        const evidence: AttemptEvidence[] = attempts.map((row) => {
          if (row.applicationEvidence === null) {
            throw new Error(`attempt '${effect.id}/${row.attemptNo}' lacks application evidence`)
          }
          return {
            attemptNo: row.attemptNo,
            state: row.state,
            applicationEvidence: row.applicationEvidence,
          }
        })
        const outcome = aggregateEffectOutcome(evidence)
        if (outcome.state === 'outcome-unknown') {
          // Earlier ambiguity plus a later definite failure is still unknown.
          // Keep one exact attempt/hold unresolved so only the task-wide
          // proof-backed closure can terminalize the generation.
          tx.update(taskExecutionEffectAttempts)
            .set({
              state: 'recovery-required',
              settledAt: null,
              failureCode: input.failureCode ?? 'aggregate-outcome-unknown',
              updatedAt: now,
            })
            .where(
              and(
                eq(taskExecutionEffectAttempts.id, attempt.id),
                eq(taskExecutionEffectAttempts.epoch, input.token.epoch),
              ),
            )
            .run()
          input.onSettledTx?.(tx)
          return
        }
        // Known terminal outcome: release only this immutable attempt's hold.
        tx.update(taskExecutionEffectFences)
          .set({ releasedAt: now })
          .where(
            and(
              eq(taskExecutionEffectFences.effectAttemptId, attempt.id),
              isNull(taskExecutionEffectFences.releasedAt),
              eq(taskExecutionEffectFences.acquiredEpoch, input.token.epoch),
            ),
          )
          .run()
        const logicalReceipt = JSON.stringify({
          v: 1,
          appliedAttemptNo: outcome.appliedAttemptNo,
          priorAmbiguityCount: outcome.priorAmbiguityCount,
          lastAttemptReceipt: receipt === null ? null : JSON.parse(receipt),
        })
        tx.update(taskExecutionEffects)
          .set({
            state: outcome.state,
            receiptJson: logicalReceipt,
            failureCode: input.failureCode ?? null,
            settledAt: now,
            updatedAt: now,
          })
          .where(
            and(eq(taskExecutionEffects.id, effect.id), eq(taskExecutionEffects.state, 'open')),
          )
          .run()

        const watermark = tx
          .select()
          .from(taskExecutionLineageOperationRecords)
          .where(
            and(
              eq(taskExecutionLineageOperationRecords.recordKind, 'generation-watermark'),
              eq(
                taskExecutionLineageOperationRecords.executionLineageId,
                effect.executionLineageId,
              ),
              eq(
                taskExecutionLineageOperationRecords.operationFamilyKey,
                effect.operationFamilyKey,
              ),
            ),
          )
          .get()
        if (
          watermark !== undefined &&
          (watermark.highestSettledGeneration ?? -1) > effect.operationGeneration
        ) {
          throw new Error('operation generation regressed below retained watermark')
        }
        if (
          watermark !== undefined &&
          watermark.highestSettledGeneration === effect.operationGeneration &&
          (watermark.requestHash !== effect.requestHash ||
            watermark.slotPathDigest !== effect.slotPathDigest)
        ) {
          throw new Error('operation generation digest differs from retained watermark')
        }
        if (watermark === undefined) {
          tx.insert(taskExecutionLineageOperationRecords)
            .values({
              id: ulid(),
              recordKind: 'generation-watermark',
              executionLineageId: effect.executionLineageId,
              operationFamilyKey: effect.operationFamilyKey,
              operationGeneration: null,
              highestSettledGeneration: effect.operationGeneration,
              lastOutcome: outcome.state,
              requestHash: effect.requestHash,
              slotPathJson: effect.slotPathJson,
              slotPathDigest: effect.slotPathDigest,
              rootAnchorTaskId: effect.taskId,
              currentAnchorTaskId: effect.taskId,
              recordRevision: 1,
              createdAt: now,
              updatedAt: now,
            })
            .run()
        } else {
          tx.update(taskExecutionLineageOperationRecords)
            .set({
              highestSettledGeneration: Math.max(
                watermark.highestSettledGeneration ?? -1,
                effect.operationGeneration,
              ),
              lastOutcome: outcome.state,
              requestHash: effect.requestHash,
              slotPathJson: effect.slotPathJson,
              slotPathDigest: effect.slotPathDigest,
              currentAnchorTaskId: effect.taskId,
              recordRevision: watermark.recordRevision + 1,
              updatedAt: now,
            })
            .where(
              and(
                eq(taskExecutionLineageOperationRecords.id, watermark.id),
                eq(taskExecutionLineageOperationRecords.recordRevision, watermark.recordRevision),
              ),
            )
            .run()
        }
        input.onSettledTx?.(tx)
      },
    })
  }

  // RFC-359 W10 —— 同步的 `closeOutcomeUnknownAndRelease`（一笔 `dbTxSync`：owner 围栏 +
  // 未决效应集合逐项 outcome-unknown + 生成 replay 决定 + 释放 owner）已删除。它自 W1-T7b 起
  // 就没有生产调用方——driver 释放序列（`taskDriverRelease.ts`）走的是端口，落到两个引擎共用的
  // `effectQuiescence.ts#closeOutcomeUnknownAndRelease`（中立事务 + `lockAndAssertOwnerTx`）；
  // 留着的只有三处测试直调，已改指中立那份。
}
