import { and, desc, eq, inArray, isNull, max } from 'drizzle-orm'
import { ulid } from 'ulid'
import {
  nodeRuns,
  taskExecutionEffectAttempts,
  taskExecutionEffectFences,
  taskExecutionEffects,
  taskExecutionIntents,
  taskExecutionLineageOperationRecords,
  taskExecutionOwners,
} from '@/db/schema'
import { dbTxSync, type DbTxSync } from '@/db/txSync'
import type {
  CodeHostAttemptPlan,
  PrepareEffectAttemptInput,
  PreparedEffectAttempt,
  RecoveredCodeHostMutationInput,
  RecoveredCodeHostMutationResolution,
  RecoveredManagedProcessResolution,
  SettleEffectAttemptInput,
  TaskExecutionEffectStore,
} from '../application/ports/taskExecutionEffectStore'
import type { TaskOwnershipStore } from '../application/ports/taskOwnershipStore'
import { TaskExecutionError } from '../application/taskExecutionError'
import { terminalizeTaskExecutionIntentsTx } from '../application/terminalizeExecutionIntent'
import {
  aggregateEffectOutcome,
  assertAttemptTransition,
  canCreateNextAttempt,
  canonicalResourceKeySet,
  type AttemptEvidence,
} from '../domain/executionEffect'
import { codeHostRecoveryClass, decodeCodeHostRecoveryDescriptor } from '../domain/codeHostRecovery'
import {
  assertExclusiveDaemonLockProof,
  assertOwnershipToken,
  assertVerifiedOutcomeUnknownClosure,
  assertVerifiedStopProof,
  createOwnershipToken,
  createWorkerIdentity,
  type ExclusiveDaemonLockProof,
  type OwnerSnapshot,
  type OwnershipToken,
  type OwnershipTuple,
  type VerifiedOutcomeUnknownClosure,
  type VerifiedStopProof,
} from '../domain/ownership'

const MAX_EFFECT_RECEIPT_BYTES = 64 * 1024
const MANAGED_PROCESS_RECOVERY_CLASS = 'managed-process-preactivation'

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

function parseJsonRecord(value: string | null): Readonly<Record<string, unknown>> | null {
  if (value === null) return null
  try {
    const parsed: unknown = JSON.parse(value)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Readonly<Record<string, unknown>>)
      : null
  } catch {
    return null
  }
}

function recoveredManagedProcessEvidence(input: {
  attemptState: typeof taskExecutionEffectAttempts.$inferSelect.state
  receiptJson: string | null
  run: typeof nodeRuns.$inferSelect
}): 'applied' | 'definitely-not-applied' | null {
  if (input.run.status === 'pending' || input.run.status === 'running') return null
  if (input.receiptJson === null) {
    // prepareAndAcquire and the launcher's activation gate are durable before
    // Bun.spawn. Without the atomic spawn receipt the target never received
    // its activation frame, so daemon loss cannot have run task code.
    return input.attemptState === 'prepared' || input.attemptState === 'acting'
      ? 'definitely-not-applied'
      : null
  }
  if (input.attemptState === 'prepared') return null
  const receipt = parseJsonRecord(input.receiptJson)
  if (receipt === null || receipt.v !== 1) return null
  if (receipt.phase !== 'spawn-receipt' && receipt.phase !== 'reaped') return null
  if (
    typeof receipt.pid !== 'number' ||
    receipt.pid !== input.run.pid ||
    typeof receipt.launchNonce !== 'string' ||
    receipt.launchNonce.length === 0 ||
    receipt.launchNonce !== input.run.spawnLaunchNonce
  ) {
    return null
  }
  if (
    receipt.phase === 'spawn-receipt' &&
    (typeof receipt.spawnBinaryPath !== 'string' ||
      receipt.spawnBinaryPath.length === 0 ||
      receipt.spawnBinaryPath !== input.run.spawnBinaryPath)
  ) {
    return null
  }
  return 'applied'
}

export class SqliteTaskExecutionEffectStore implements TaskExecutionEffectStore {
  constructor(private readonly ownership: TaskOwnershipStore) {}

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

  resolveQuiescedManagedProcesses(
    input: {
      db: Parameters<TaskOwnershipStore['read']>[0]
      quiescenceEvidenceDigest: string
      now?: number
    } & (
      | {
          authority: 'successor-daemon'
          owner: OwnershipTuple
          expectedRevision: number
          lockProof: ExclusiveDaemonLockProof
        }
      | {
          authority: 'exact-stop'
          token: OwnershipToken
          expectedRevision: number
          proof: VerifiedStopProof
        }
    ),
  ): RecoveredManagedProcessResolution {
    if (input.quiescenceEvidenceDigest.length === 0) {
      throw new Error('managed-process recovery requires quiescence evidence')
    }
    let recoveredOwner: OwnershipTuple
    let allowedOwnerStates: readonly ('claimed' | 'revoked' | 'recovery-required')[]
    if (input.authority === 'successor-daemon') {
      assertExclusiveDaemonLockProof(input.lockProof)
      if (input.lockProof.daemonGeneration === input.owner.daemonGeneration) {
        throw new Error('managed-process successor recovery requires a new daemon generation')
      }
      recoveredOwner = input.owner
      allowedOwnerStates = ['revoked', 'recovery-required']
    } else {
      assertOwnershipToken(input.token)
      assertVerifiedStopProof(input.proof)
      if (
        input.proof.taskId !== input.token.taskId ||
        input.proof.epoch !== input.token.epoch ||
        input.proof.ownerRevision !== input.expectedRevision
      ) {
        throw new Error('managed-process stop proof does not match the exact owner')
      }
      recoveredOwner = {
        taskId: input.token.taskId,
        ownerId: input.token.ownerId,
        daemonGeneration: input.token.daemonGeneration,
        epoch: input.token.epoch,
      }
      allowedOwnerStates = ['claimed', 'revoked', 'recovery-required']
    }
    const now = input.now ?? Date.now()
    return dbTxSync(input.db, (tx) => {
      const owner = tx
        .select()
        .from(taskExecutionOwners)
        .where(eq(taskExecutionOwners.taskId, recoveredOwner.taskId))
        .get()
      if (
        owner === undefined ||
        owner.ownerId !== recoveredOwner.ownerId ||
        owner.daemonGeneration !== recoveredOwner.daemonGeneration ||
        owner.epoch !== recoveredOwner.epoch ||
        owner.revision !== input.expectedRevision ||
        !allowedOwnerStates.includes(owner.state as (typeof allowedOwnerStates)[number])
      ) {
        throw new TaskExecutionError(
          'task-execution-stale-owner',
          `task '${recoveredOwner.taskId}' managed-process recovery was fenced`,
        )
      }

      const unresolved = tx
        .select({
          attempt: taskExecutionEffectAttempts,
          effect: taskExecutionEffects,
        })
        .from(taskExecutionEffectAttempts)
        .innerJoin(
          taskExecutionEffects,
          eq(taskExecutionEffects.id, taskExecutionEffectAttempts.effectId),
        )
        .where(
          and(
            eq(taskExecutionEffects.taskId, recoveredOwner.taskId),
            eq(taskExecutionEffects.kind, 'process'),
            eq(taskExecutionEffects.state, 'open'),
            inArray(taskExecutionEffectAttempts.state, ['prepared', 'acting', 'recovery-required']),
          ),
        )
        .all()
        .sort(
          (left, right) =>
            left.effect.operationGeneration - right.effect.operationGeneration ||
            left.attempt.attemptNo - right.attempt.attemptNo,
        )
      const unresolvedCountByEffect = new Map<string, number>()
      for (const row of unresolved) {
        unresolvedCountByEffect.set(
          row.effect.id,
          (unresolvedCountByEffect.get(row.effect.id) ?? 0) + 1,
        )
      }
      const resolvedEffectIds: string[] = []
      const unresolvedEffectIds = new Set<string>()

      for (const { attempt, effect } of unresolved) {
        if (
          unresolvedCountByEffect.get(effect.id) !== 1 ||
          attempt.epoch !== recoveredOwner.epoch ||
          attempt.recoveryClass !== MANAGED_PROCESS_RECOVERY_CLASS
        ) {
          unresolvedEffectIds.add(effect.id)
          continue
        }
        const candidate = /^(agent|script):(.+)$/.exec(attempt.candidateId)
        if (candidate === null) {
          unresolvedEffectIds.add(effect.id)
          continue
        }
        const run = tx
          .select()
          .from(nodeRuns)
          .where(and(eq(nodeRuns.id, candidate[2]!), eq(nodeRuns.taskId, recoveredOwner.taskId)))
          .get()
        if (run === undefined) {
          unresolvedEffectIds.add(effect.id)
          continue
        }
        const applicationEvidence = recoveredManagedProcessEvidence({
          attemptState: attempt.state,
          receiptJson: attempt.receiptJson,
          run,
        })
        if (applicationEvidence === null) {
          unresolvedEffectIds.add(effect.id)
          continue
        }
        const attemptState = applicationEvidence === 'applied' ? 'succeeded' : 'failed-not-applied'
        assertAttemptTransition(attempt.state, attemptState)
        const projectedAttempts: AttemptEvidence[] = tx
          .select({
            attemptNo: taskExecutionEffectAttempts.attemptNo,
            state: taskExecutionEffectAttempts.state,
            applicationEvidence: taskExecutionEffectAttempts.applicationEvidence,
          })
          .from(taskExecutionEffectAttempts)
          .where(eq(taskExecutionEffectAttempts.effectId, effect.id))
          .orderBy(taskExecutionEffectAttempts.attemptNo)
          .all()
          .map((row) =>
            row.attemptNo === attempt.attemptNo
              ? { attemptNo: row.attemptNo, state: attemptState, applicationEvidence }
              : row.applicationEvidence === null
                ? {
                    attemptNo: row.attemptNo,
                    state: row.state,
                    applicationEvidence: 'ambiguous' as const,
                  }
                : {
                    attemptNo: row.attemptNo,
                    state: row.state,
                    applicationEvidence: row.applicationEvidence,
                  },
          )
        let outcome: ReturnType<typeof aggregateEffectOutcome>
        try {
          outcome = aggregateEffectOutcome(projectedAttempts)
        } catch {
          unresolvedEffectIds.add(effect.id)
          continue
        }
        if (outcome.state === 'outcome-unknown') {
          unresolvedEffectIds.add(effect.id)
          continue
        }

        const failureCode =
          applicationEvidence === 'definitely-not-applied'
            ? 'daemon-restart-before-process-activation'
            : null
        tx.update(taskExecutionEffectAttempts)
          .set({
            state: attemptState,
            applicationEvidence,
            retryAuthority: 'none',
            failureCode,
            settledAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(taskExecutionEffectAttempts.id, attempt.id),
              eq(taskExecutionEffectAttempts.epoch, recoveredOwner.epoch),
              eq(taskExecutionEffectAttempts.state, attempt.state),
            ),
          )
          .run()
        tx.update(taskExecutionEffectFences)
          .set({ releasedAt: now })
          .where(
            and(
              eq(taskExecutionEffectFences.effectAttemptId, attempt.id),
              isNull(taskExecutionEffectFences.releasedAt),
              eq(taskExecutionEffectFences.acquiredEpoch, recoveredOwner.epoch),
            ),
          )
          .run()
        tx.update(taskExecutionEffects)
          .set({
            state: outcome.state,
            failureCode,
            receiptJson: JSON.stringify({
              v: 1,
              recovery: 'daemon-restart-process-barrier',
              quiescenceEvidenceDigest: input.quiescenceEvidenceDigest,
              nodeRunId: run.id,
              nodeRunStatus: run.status,
              appliedAttemptNo: outcome.appliedAttemptNo,
              priorAmbiguityCount: outcome.priorAmbiguityCount,
              priorReceipt:
                attempt.receiptJson === null ? null : parseJsonRecord(attempt.receiptJson),
            }),
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
          throw new Error('recovered process generation regressed below retained watermark')
        }
        if (
          watermark !== undefined &&
          watermark.highestSettledGeneration === effect.operationGeneration &&
          (watermark.requestHash !== effect.requestHash ||
            watermark.slotPathDigest !== effect.slotPathDigest)
        ) {
          throw new Error('recovered process digest differs from retained watermark')
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
        resolvedEffectIds.push(effect.id)
        unresolvedEffectIds.delete(effect.id)
      }

      return {
        resolvedEffectIds: [...new Set(resolvedEffectIds)].sort(),
        unresolvedEffectIds: [...unresolvedEffectIds].sort(),
      }
    })
  }

  resolveQuiescedCodeHostMutations(input: {
    db: Parameters<TaskOwnershipStore['read']>[0]
    owner: OwnershipTuple
    expectedRevision: number
    lockProof: ExclusiveDaemonLockProof
    quiescenceEvidenceDigest: string
    resolutions: readonly RecoveredCodeHostMutationInput[]
    onAppliedTx?: (tx: DbTxSync, resolution: RecoveredCodeHostMutationInput) => void
    now?: number
  }): RecoveredCodeHostMutationResolution {
    assertExclusiveDaemonLockProof(input.lockProof)
    if (input.lockProof.daemonGeneration === input.owner.daemonGeneration) {
      throw new Error('code-host successor recovery requires a new daemon generation')
    }
    if (input.quiescenceEvidenceDigest.length === 0) {
      throw new Error('code-host recovery requires quiescence evidence')
    }
    const resolutionKeys = new Set<string>()
    const normalized = input.resolutions.map((resolution) => {
      const key = `${resolution.effectId}\u0000${resolution.attemptId}`
      if (resolutionKeys.has(key)) throw new Error('duplicate code-host recovery resolution')
      resolutionKeys.add(key)
      if (
        !Number.isInteger(resolution.responseStatus) ||
        resolution.responseStatus < 100 ||
        resolution.responseStatus > 599
      ) {
        throw new Error('invalid code-host recovery response status')
      }
      const receiptJson = boundedReceipt(resolution.receiptJson)
      if (receiptJson === null) throw new Error('code-host recovery requires a receipt')
      return { resolution, receiptJson }
    })
    const now = input.now ?? Date.now()

    return dbTxSync(input.db, (tx) => {
      const owner = tx
        .select()
        .from(taskExecutionOwners)
        .where(eq(taskExecutionOwners.taskId, input.owner.taskId))
        .get()
      if (
        owner === undefined ||
        owner.ownerId !== input.owner.ownerId ||
        owner.daemonGeneration !== input.owner.daemonGeneration ||
        owner.epoch !== input.owner.epoch ||
        owner.revision !== input.expectedRevision ||
        !['revoked', 'recovery-required'].includes(owner.state)
      ) {
        throw new TaskExecutionError(
          'task-execution-stale-owner',
          `task '${input.owner.taskId}' code-host recovery was fenced`,
        )
      }

      const appliedEffectIds: string[] = []
      const retryAuthorizedEffectIds: string[] = []
      for (const { resolution, receiptJson } of normalized) {
        const row = tx
          .select({
            attempt: taskExecutionEffectAttempts,
            effect: taskExecutionEffects,
          })
          .from(taskExecutionEffectAttempts)
          .innerJoin(
            taskExecutionEffects,
            eq(taskExecutionEffects.id, taskExecutionEffectAttempts.effectId),
          )
          .where(eq(taskExecutionEffectAttempts.id, resolution.attemptId))
          .get()
        if (
          row === undefined ||
          row.effect.id !== resolution.effectId ||
          row.effect.taskId !== input.owner.taskId ||
          row.effect.kind !== 'code-host-mutation' ||
          row.effect.state !== 'open' ||
          row.attempt.epoch !== input.owner.epoch ||
          (row.attempt.state !== 'acting' && row.attempt.state !== 'recovery-required') ||
          row.attempt.recoveryDescriptorJson === null
        ) {
          throw new TaskExecutionError(
            'task-execution-recovery-required',
            `code-host recovery target '${resolution.effectId}/${resolution.attemptId}' is not the exact open attempt`,
          )
        }

        let descriptor: ReturnType<typeof decodeCodeHostRecoveryDescriptor>
        try {
          descriptor = decodeCodeHostRecoveryDescriptor(row.attempt.recoveryDescriptorJson)
        } catch {
          throw new TaskExecutionError(
            'task-execution-recovery-required',
            `code-host attempt '${row.attempt.id}' has no usable recovery descriptor`,
          )
        }
        const declaredRecoveryClass = codeHostRecoveryClass(descriptor.action, descriptor.method)
        if (
          descriptor.probe.kind === 'actor-replay' ||
          declaredRecoveryClass === 'R-ACTOR' ||
          declaredRecoveryClass === 'R-READ' ||
          row.attempt.recoveryClass !== declaredRecoveryClass ||
          !/^:t[1-9]\d*$/.test(row.attempt.candidateId.slice(descriptor.candidateId.length)) ||
          !row.attempt.candidateId.startsWith(descriptor.candidateId) ||
          descriptor.nodeRunId !== resolution.nodeRunId
        ) {
          throw new TaskExecutionError(
            'task-execution-recovery-required',
            `code-host attempt '${row.attempt.id}' is not eligible for deterministic recovery`,
          )
        }

        const nextState =
          resolution.outcome === 'applied' ? ('succeeded' as const) : ('retry-authorized' as const)
        assertAttemptTransition(row.attempt.state, nextState)

        let outcome: ReturnType<typeof aggregateEffectOutcome> | null = null
        if (resolution.outcome === 'applied') {
          const projectedAttempts: AttemptEvidence[] = tx
            .select({
              attemptNo: taskExecutionEffectAttempts.attemptNo,
              state: taskExecutionEffectAttempts.state,
              applicationEvidence: taskExecutionEffectAttempts.applicationEvidence,
            })
            .from(taskExecutionEffectAttempts)
            .where(eq(taskExecutionEffectAttempts.effectId, row.effect.id))
            .orderBy(taskExecutionEffectAttempts.attemptNo)
            .all()
            .map((attempt) =>
              attempt.attemptNo === row.attempt.attemptNo
                ? {
                    attemptNo: attempt.attemptNo,
                    state: 'succeeded' as const,
                    applicationEvidence: 'applied' as const,
                  }
                : attempt.applicationEvidence === null
                  ? {
                      attemptNo: attempt.attemptNo,
                      state: attempt.state,
                      applicationEvidence: 'ambiguous' as const,
                    }
                  : {
                      attemptNo: attempt.attemptNo,
                      state: attempt.state,
                      applicationEvidence: attempt.applicationEvidence,
                    },
            )
          outcome = aggregateEffectOutcome(projectedAttempts)
          if (outcome.state !== 'succeeded') {
            throw new TaskExecutionError(
              'task-execution-recovery-required',
              `code-host attempt '${row.attempt.id}' did not produce a known applied outcome`,
            )
          }
        }

        const attemptUpdate = tx
          .update(taskExecutionEffectAttempts)
          .set({
            state: nextState,
            applicationEvidence:
              resolution.outcome === 'applied' ? 'applied' : 'definitely-not-applied',
            retryAuthority: resolution.outcome === 'applied' ? 'none' : 'probe',
            receiptJson,
            failureCode:
              resolution.outcome === 'applied' ? null : 'code-host-probe-definitely-not-applied',
            settledAt: resolution.outcome === 'applied' ? now : null,
            updatedAt: now,
          })
          .where(
            and(
              eq(taskExecutionEffectAttempts.id, row.attempt.id),
              eq(taskExecutionEffectAttempts.epoch, input.owner.epoch),
              eq(taskExecutionEffectAttempts.state, row.attempt.state),
            ),
          )
          .returning({ id: taskExecutionEffectAttempts.id })
          .get()
        if (attemptUpdate === undefined) {
          throw new TaskExecutionError(
            'task-execution-stale-owner',
            `code-host attempt '${row.attempt.id}' recovery lost its compare-and-swap`,
          )
        }
        tx.update(taskExecutionEffectFences)
          .set({ releasedAt: now })
          .where(
            and(
              eq(taskExecutionEffectFences.effectAttemptId, row.attempt.id),
              isNull(taskExecutionEffectFences.releasedAt),
              eq(taskExecutionEffectFences.acquiredEpoch, input.owner.epoch),
            ),
          )
          .run()

        if (resolution.outcome === 'definitely-not-applied') {
          retryAuthorizedEffectIds.push(row.effect.id)
          continue
        }
        if (outcome === null) throw new Error('applied code-host recovery lacks an outcome')
        const effectUpdate = tx
          .update(taskExecutionEffects)
          .set({
            state: 'succeeded',
            failureCode: null,
            receiptJson: JSON.stringify({
              v: 1,
              recovery: 'daemon-restart-code-host-probe',
              quiescenceEvidenceDigest: input.quiescenceEvidenceDigest,
              attemptId: row.attempt.id,
              attemptNo: row.attempt.attemptNo,
              nodeRunId: resolution.nodeRunId,
              responseStatus: resolution.responseStatus,
              appliedAttemptNo: outcome.appliedAttemptNo,
              priorAmbiguityCount: outcome.priorAmbiguityCount,
              probeReceipt: JSON.parse(receiptJson),
            }),
            settledAt: now,
            updatedAt: now,
          })
          .where(
            and(eq(taskExecutionEffects.id, row.effect.id), eq(taskExecutionEffects.state, 'open')),
          )
          .returning({ id: taskExecutionEffects.id })
          .get()
        if (effectUpdate === undefined) {
          throw new TaskExecutionError(
            'task-execution-stale-owner',
            `code-host effect '${row.effect.id}' recovery lost its compare-and-swap`,
          )
        }

        const watermark = tx
          .select()
          .from(taskExecutionLineageOperationRecords)
          .where(
            and(
              eq(taskExecutionLineageOperationRecords.recordKind, 'generation-watermark'),
              eq(
                taskExecutionLineageOperationRecords.executionLineageId,
                row.effect.executionLineageId,
              ),
              eq(
                taskExecutionLineageOperationRecords.operationFamilyKey,
                row.effect.operationFamilyKey,
              ),
            ),
          )
          .get()
        if (
          watermark !== undefined &&
          (watermark.highestSettledGeneration ?? -1) > row.effect.operationGeneration
        ) {
          throw new Error('recovered code-host generation regressed below retained watermark')
        }
        if (
          watermark !== undefined &&
          watermark.highestSettledGeneration === row.effect.operationGeneration &&
          (watermark.requestHash !== row.effect.requestHash ||
            watermark.slotPathDigest !== row.effect.slotPathDigest)
        ) {
          throw new Error('recovered code-host digest differs from retained watermark')
        }
        if (watermark === undefined) {
          tx.insert(taskExecutionLineageOperationRecords)
            .values({
              id: ulid(),
              recordKind: 'generation-watermark',
              executionLineageId: row.effect.executionLineageId,
              operationFamilyKey: row.effect.operationFamilyKey,
              operationGeneration: null,
              highestSettledGeneration: row.effect.operationGeneration,
              lastOutcome: 'succeeded',
              requestHash: row.effect.requestHash,
              slotPathJson: row.effect.slotPathJson,
              slotPathDigest: row.effect.slotPathDigest,
              rootAnchorTaskId: row.effect.taskId,
              currentAnchorTaskId: row.effect.taskId,
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
                row.effect.operationGeneration,
              ),
              lastOutcome: 'succeeded',
              requestHash: row.effect.requestHash,
              slotPathJson: row.effect.slotPathJson,
              slotPathDigest: row.effect.slotPathDigest,
              currentAnchorTaskId: row.effect.taskId,
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
        input.onAppliedTx?.(tx, resolution)
        appliedEffectIds.push(row.effect.id)
      }

      return {
        appliedEffectIds: [...new Set(appliedEffectIds)].sort(),
        retryAuthorizedEffectIds: [...new Set(retryAuthorizedEffectIds)].sort(),
      }
    })
  }

  /**
   * Terminalize an ambiguous execution generation only after the runtime has
   * produced a task-wide quiescence proof.  This is deliberately separate from
   * ordinary worker settlement: a response-loss path may mark recovery-required,
   * but it cannot release resource holds or the task owner by itself.
   */
  closeOutcomeUnknownAndRelease(input: {
    db: Parameters<TaskOwnershipStore['read']>[0]
    token: Parameters<TaskOwnershipStore['heartbeat']>[0]['token']
    intentId: string
    proof: VerifiedOutcomeUnknownClosure
    now?: number
  }): OwnerSnapshot {
    assertOwnershipToken(input.token)
    assertVerifiedOutcomeUnknownClosure(input.proof)
    if (input.proof.taskId !== input.token.taskId || input.proof.epoch !== input.token.epoch) {
      throw new Error('outcome-unknown closure does not match ownership token')
    }
    const now = input.now ?? Date.now()
    return dbTxSync(input.db, (tx) => {
      const owner = tx
        .select()
        .from(taskExecutionOwners)
        .where(eq(taskExecutionOwners.taskId, input.token.taskId))
        .get()
      if (
        owner === undefined ||
        owner.taskId !== input.token.taskId ||
        owner.ownerId !== input.token.ownerId ||
        owner.daemonGeneration !== input.token.daemonGeneration ||
        owner.epoch !== input.token.epoch ||
        owner.revision !== input.proof.ownerRevision ||
        !['claimed', 'revoked', 'recovery-required'].includes(owner.state)
      ) {
        throw new TaskExecutionError(
          'task-execution-stale-owner',
          `task '${input.token.taskId}' outcome-unknown closure was fenced`,
        )
      }

      const unresolved = tx
        .select({
          attempt: taskExecutionEffectAttempts,
          effect: taskExecutionEffects,
        })
        .from(taskExecutionEffectAttempts)
        .innerJoin(
          taskExecutionEffects,
          eq(taskExecutionEffects.id, taskExecutionEffectAttempts.effectId),
        )
        .where(
          and(
            eq(taskExecutionEffects.taskId, input.token.taskId),
            eq(taskExecutionEffects.state, 'open'),
            inArray(taskExecutionEffectAttempts.state, ['prepared', 'acting', 'recovery-required']),
          ),
        )
        .all()
      const actualEffectIds = [...new Set(unresolved.map((row) => row.effect.id))].sort()
      const provenEffectIds = [...new Set(input.proof.unresolvedEffectIds)].sort()
      if (
        actualEffectIds.length === 0 ||
        actualEffectIds.length !== provenEffectIds.length ||
        actualEffectIds.some((id, index) => id !== provenEffectIds[index])
      ) {
        throw new TaskExecutionError(
          'task-execution-recovery-required',
          'task-wide quiescence proof does not cover the exact unresolved effect set',
        )
      }

      for (const { attempt, effect } of unresolved) {
        tx.update(taskExecutionEffectAttempts)
          .set({
            state: 'outcome-unknown',
            applicationEvidence: 'ambiguous',
            retryAuthority: 'none',
            failureCode: attempt.failureCode ?? 'outcome-unknown-after-quiescence',
            settledAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(taskExecutionEffectAttempts.id, attempt.id),
              eq(taskExecutionEffectAttempts.epoch, input.token.epoch),
              inArray(taskExecutionEffectAttempts.state, [
                'prepared',
                'acting',
                'recovery-required',
              ]),
            ),
          )
          .run()
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
        tx.update(taskExecutionEffects)
          .set({
            state: 'outcome-unknown',
            failureCode: attempt.failureCode ?? 'outcome-unknown-after-quiescence',
            receiptJson: JSON.stringify({
              v: 1,
              closureDigest: input.proof.quiescenceDigest,
              attemptId: attempt.id,
              attemptNo: attempt.attemptNo,
            }),
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
        if (watermark === undefined) {
          tx.insert(taskExecutionLineageOperationRecords)
            .values({
              id: ulid(),
              recordKind: 'generation-watermark',
              executionLineageId: effect.executionLineageId,
              operationFamilyKey: effect.operationFamilyKey,
              operationGeneration: null,
              highestSettledGeneration: effect.operationGeneration,
              lastOutcome: 'outcome-unknown',
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
        } else if ((watermark.highestSettledGeneration ?? -1) <= effect.operationGeneration) {
          tx.update(taskExecutionLineageOperationRecords)
            .set({
              highestSettledGeneration: effect.operationGeneration,
              lastOutcome: 'outcome-unknown',
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

        const decision = tx
          .select({ id: taskExecutionLineageOperationRecords.id })
          .from(taskExecutionLineageOperationRecords)
          .where(
            and(
              eq(taskExecutionLineageOperationRecords.recordKind, 'replay-decision'),
              eq(
                taskExecutionLineageOperationRecords.executionLineageId,
                effect.executionLineageId,
              ),
              eq(
                taskExecutionLineageOperationRecords.operationFamilyKey,
                effect.operationFamilyKey,
              ),
              eq(
                taskExecutionLineageOperationRecords.operationGeneration,
                effect.operationGeneration,
              ),
            ),
          )
          .get()
        if (decision === undefined) {
          tx.insert(taskExecutionLineageOperationRecords)
            .values({
              id: ulid(),
              recordKind: 'replay-decision',
              executionLineageId: effect.executionLineageId,
              operationFamilyKey: effect.operationFamilyKey,
              operationGeneration: effect.operationGeneration,
              highestSettledGeneration: null,
              lastOutcome: 'outcome-unknown',
              requestHash: effect.requestHash,
              slotPathJson: effect.slotPathJson,
              slotPathDigest: effect.slotPathDigest,
              rootAnchorTaskId: effect.taskId,
              currentAnchorTaskId: effect.taskId,
              sourceTaskId: effect.taskId,
              sourceEffectId: effect.id,
              sourceAttemptId: attempt.id,
              failureCode: attempt.failureCode ?? 'outcome-unknown-after-quiescence',
              decisionState: 'requires-actor',
              recordRevision: 1,
              createdAt: now,
              updatedAt: now,
            })
            .run()
        }
      }

      terminalizeTaskExecutionIntentsTx({
        tx,
        taskId: input.token.taskId,
        state: 'failed',
        failureCode: 'task-execution-outcome-unknown',
        now,
      })
      const released = tx
        .update(taskExecutionOwners)
        .set({
          state: 'released',
          revision: owner.revision + 1,
          recoveryCode: 'task-execution-outcome-unknown',
          recoveryProofDigest: input.proof.quiescenceDigest,
          updatedAt: now,
        })
        .where(
          and(
            eq(taskExecutionOwners.taskId, input.token.taskId),
            eq(taskExecutionOwners.ownerId, input.token.ownerId),
            eq(taskExecutionOwners.daemonGeneration, input.token.daemonGeneration),
            eq(taskExecutionOwners.epoch, input.token.epoch),
            eq(taskExecutionOwners.revision, owner.revision),
            inArray(taskExecutionOwners.state, ['claimed', 'revoked', 'recovery-required']),
          ),
        )
        .returning()
        .get()
      if (released === undefined) {
        throw new TaskExecutionError(
          'task-execution-stale-owner',
          `task '${input.token.taskId}' outcome-unknown release lost`,
        )
      }
      return {
        taskId: released.taskId,
        ownerId: released.ownerId,
        daemonGeneration: released.daemonGeneration,
        epoch: released.epoch,
        state: released.state,
        leaseUntil: released.leaseUntil,
        revision: released.revision,
      }
    })
  }

  closeRecoveredOutcomeUnknownAndRelease(input: {
    db: Parameters<TaskOwnershipStore['read']>[0]
    owner: OwnershipTuple
    expectedRevision: number
    lockProof: ExclusiveDaemonLockProof
    proof: VerifiedOutcomeUnknownClosure
    now?: number
  }): OwnerSnapshot {
    assertExclusiveDaemonLockProof(input.lockProof)
    assertVerifiedOutcomeUnknownClosure(input.proof)
    if (
      input.lockProof.daemonGeneration === input.owner.daemonGeneration ||
      input.proof.taskId !== input.owner.taskId ||
      input.proof.epoch !== input.owner.epoch ||
      input.proof.ownerRevision !== input.expectedRevision
    ) {
      throw new Error('recovered outcome closure does not match old daemon owner')
    }
    // Reconstruct the exact old capability only inside this recovery adapter,
    // under an exclusive successor-daemon proof. It cannot pass the worker
    // gateway because the durable owner is already revoked and never escapes.
    const identity = createWorkerIdentity({
      ownerId: input.owner.ownerId,
      daemonGeneration: input.owner.daemonGeneration,
    })
    const token = createOwnershipToken({
      taskId: input.owner.taskId,
      identity,
      epoch: input.owner.epoch,
      leaseUntil: 0,
      ownerRevision: input.expectedRevision,
    })
    const intent = input.db
      .select({ id: taskExecutionIntents.id })
      .from(taskExecutionIntents)
      .where(
        and(
          eq(taskExecutionIntents.taskId, input.owner.taskId),
          eq(taskExecutionIntents.claimedEpoch, input.owner.epoch),
        ),
      )
      .get()
    if (intent === undefined) {
      throw new TaskExecutionError(
        'task-execution-recovery-required',
        `task '${input.owner.taskId}' has no intent for recovered epoch`,
      )
    }
    return this.closeOutcomeUnknownAndRelease({
      db: input.db,
      token,
      intentId: intent.id,
      proof: input.proof,
      ...(input.now !== undefined ? { now: input.now } : {}),
    })
  }
}
