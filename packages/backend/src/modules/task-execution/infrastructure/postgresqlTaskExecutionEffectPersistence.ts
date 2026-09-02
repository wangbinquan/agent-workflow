// RFC-349 — PostgreSQL effect journal, attempt ledger and resource fences.

import { and, asc, desc, eq, inArray, isNull, max, sql } from 'drizzle-orm'
import { ulid } from 'ulid'

import {
  nodeRunOutputs,
  nodeRuns,
  taskRepos,
  taskSpaceNodes,
  taskExecutionEffectAttempts,
  taskExecutionEffectFences,
  taskExecutionEffects,
  taskExecutionIntents,
  taskExecutionLineageOperationRecords,
  taskExecutionOwners,
  tasks,
} from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  CodeHostNodeSettlementProjection,
  TaskEffectAttemptSettlement,
  TaskExecutionEffectPersistence,
} from '../application/ports/taskExecutionEffectStore'
import type { GateContinuationEffectPersistence } from '../application/drive/gateContinuationEffectStep'
import { TaskExecutionError } from '../application/taskExecutionError'
import {
  aggregateEffectOutcome,
  assertAttemptTransition,
  canCreateNextAttempt,
  canonicalResourceKeySet,
  type AttemptEvidence,
} from '../domain/executionEffect'
import { assertOwnershipToken, type OwnershipToken } from '../domain/ownership'
import { createPostgresqlNodeRunLifecycleParticipantInTx } from './postgresqlNodeRunLifecyclePersistence'
import { retryPostgresqlSerialization } from '@/db/postgresqlSerializationRetry'

type PgTx = Parameters<Parameters<PostgresqlDatabaseClient['transaction']>[0]>[0]
const MAX_RECEIPT_BYTES = 64 * 1024

function bounded(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null
  if (Buffer.byteLength(value) > MAX_RECEIPT_BYTES) {
    throw new TaskExecutionError('task-continuation-conflict', 'effect receipt exceeds 64 KiB')
  }
  return value
}

function uniqueViolation(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 4 && current !== null && typeof current === 'object'; depth += 1) {
    if ((current as { readonly code?: unknown }).code === '23505') return true
    current = (current as { readonly cause?: unknown }).cause
  }
  return false
}

async function serializable<T>(db: PostgresqlDatabaseClient, body: (tx: PgTx) => Promise<T>) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await db.transaction(async (tx) => {
        await tx.run(sql.raw('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE'))
        return await body(tx)
      })
    } catch (error) {
      if (await retryPostgresqlSerialization(attempt, error)) continue
      throw error
    }
  }
}

async function assertOwner(tx: PgTx, token: OwnershipToken, now: number): Promise<void> {
  assertOwnershipToken(token)
  const rows = await tx
    .select({
      ownerId: taskExecutionOwners.ownerId,
      daemonGeneration: taskExecutionOwners.daemonGeneration,
      epoch: taskExecutionOwners.epoch,
      state: taskExecutionOwners.state,
      leaseUntil: taskExecutionOwners.leaseUntil,
      revision: taskExecutionOwners.revision,
    })
    .from(taskExecutionOwners)
    .where(eq(taskExecutionOwners.taskId, token.taskId))
    .limit(1)
  const owner = rows[0]
  if (
    owner === undefined ||
    owner.ownerId !== token.ownerId ||
    owner.daemonGeneration !== token.daemonGeneration ||
    owner.epoch !== token.epoch ||
    owner.state !== 'claimed' ||
    owner.revision !== token.ownerRevision ||
    owner.leaseUntil !== token.leaseUntil ||
    owner.leaseUntil < now
  ) {
    throw new TaskExecutionError(
      'task-execution-stale-owner',
      `task '${token.taskId}' mutation was fenced`,
    )
  }
}

async function applyCodeHostProjection(
  tx: PgTx,
  projection: CodeHostNodeSettlementProjection,
): Promise<void> {
  for (const output of projection.outputs ?? []) {
    await tx
      .insert(nodeRunOutputs)
      .values({ nodeRunId: projection.nodeRunId, ...output })
      .onConflictDoUpdate({
        target: [nodeRunOutputs.nodeRunId, nodeRunOutputs.portName],
        set: { content: output.content },
      })
      .run()
  }
  const changed = await tx
    .update(nodeRuns)
    .set({
      status: projection.status,
      finishedAt: projection.finishedAt,
      ...(projection.errorMessage === undefined ? {} : { errorMessage: projection.errorMessage }),
      ...(projection.failureCode === undefined ? {} : { failureCode: projection.failureCode }),
    })
    .where(and(eq(nodeRuns.id, projection.nodeRunId), eq(nodeRuns.status, 'running')))
    .returning({ id: nodeRuns.id })
  if (changed[0] === undefined) {
    throw new TaskExecutionError(
      'task-continuation-stale',
      `node run '${projection.nodeRunId}' changed before effect settlement`,
    )
  }
}

/** Admission-time rollback link for the PostgreSQL gate-decision atom. */
export async function linkPostgresqlWorkspaceRollbackEffectTx(
  tx: PgTx,
  input: Readonly<{
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
  }>,
): Promise<Readonly<{ effectId: string; idempotent: boolean }>> {
  const intentRows = await tx
    .select({
      taskId: taskExecutionIntents.taskId,
      kind: taskExecutionIntents.kind,
      state: taskExecutionIntents.state,
    })
    .from(taskExecutionIntents)
    .where(eq(taskExecutionIntents.id, input.intentId))
    .limit(1)
  const intent = intentRows[0]
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
  const existingRows = await tx
    .select()
    .from(taskExecutionEffects)
    .where(
      and(
        eq(taskExecutionEffects.currentIntentId, input.intentId),
        eq(taskExecutionEffects.kind, 'workspace-rollback'),
      ),
    )
    .limit(1)
  const existing = existingRows[0]
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
  await tx
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

export class PostgresqlTaskExecutionEffectPersistence implements TaskExecutionEffectPersistence {
  constructor(private readonly db: PostgresqlDatabaseClient) {}

  async readLineage(input: Parameters<TaskExecutionEffectPersistence['readLineage']>[0]) {
    const taskRows = await this.db
      .select({
        executionLineageId: tasks.executionLineageId,
        lineageSlotPathJson: tasks.lineageSlotPathJson,
        workflowVersion: tasks.workflowVersion,
      })
      .from(tasks)
      .where(eq(tasks.id, input.taskId))
      .limit(1)
    const intentRows = await this.db
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
      .limit(1)
    const runRows =
      input.nodeRunId === undefined
        ? []
        : await this.db
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
            .limit(1)
    const task = taskRows[0]
    const intent = intentRows[0]
    const run = runRows[0]
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

  async nextOperationGeneration(
    input: Parameters<TaskExecutionEffectPersistence['nextOperationGeneration']>[0],
  ): Promise<number> {
    const live = await this.db
      .select({ generation: max(taskExecutionEffects.operationGeneration) })
      .from(taskExecutionEffects)
      .where(
        and(
          eq(taskExecutionEffects.executionLineageId, input.executionLineageId),
          eq(taskExecutionEffects.operationFamilyKey, input.operationFamilyKey),
        ),
      )
    const retained = await this.db
      .select({ generation: taskExecutionLineageOperationRecords.highestSettledGeneration })
      .from(taskExecutionLineageOperationRecords)
      .where(
        and(
          eq(taskExecutionLineageOperationRecords.recordKind, 'generation-watermark'),
          eq(taskExecutionLineageOperationRecords.executionLineageId, input.executionLineageId),
          eq(taskExecutionLineageOperationRecords.operationFamilyKey, input.operationFamilyKey),
        ),
      )
      .limit(1)
    return Math.max(live[0]?.generation ?? -1, retained[0]?.generation ?? -1) + 1
  }

  async planCodeHostAttempt(
    input: Parameters<TaskExecutionEffectPersistence['planCodeHostAttempt']>[0],
  ) {
    const effects = await this.db
      .select()
      .from(taskExecutionEffects)
      .where(
        and(
          eq(taskExecutionEffects.executionLineageId, input.executionLineageId),
          eq(taskExecutionEffects.operationFamilyKey, input.operationFamilyKey),
        ),
      )
      .orderBy(desc(taskExecutionEffects.operationGeneration))
      .limit(1)
    const highest = effects[0]
    if (highest?.state === 'open') {
      const attempts = await this.db
        .select({
          state: taskExecutionEffectAttempts.state,
          retryAuthority: taskExecutionEffectAttempts.retryAuthority,
        })
        .from(taskExecutionEffectAttempts)
        .where(eq(taskExecutionEffectAttempts.effectId, highest.id))
        .orderBy(desc(taskExecutionEffectAttempts.attemptNo))
        .limit(1)
      const latest = attempts[0]
      if (latest?.state === 'retry-authorized' && latest.retryAuthority !== 'none') {
        return {
          operationGeneration: highest.operationGeneration,
          retryAuthority: latest.retryAuthority,
        }
      }
    }
    return {
      operationGeneration: await this.nextOperationGeneration(input),
      retryAuthority: 'none' as const,
    }
  }

  async prepareAndAcquire(
    input: Parameters<TaskExecutionEffectPersistence['prepareAndAcquire']>[0],
  ) {
    const now = input.now ?? Date.now()
    const resources = canonicalResourceKeySet(input.resourceKeys)
    const recoveryDescriptorJson = bounded(input.recoveryDescriptorJson)
    return await serializable(this.db, async (tx) => {
      await assertOwner(tx, input.token, now)
      const intents = await tx
        .select({
          id: taskExecutionIntents.id,
          taskId: taskExecutionIntents.taskId,
          state: taskExecutionIntents.state,
          claimedEpoch: taskExecutionIntents.claimedEpoch,
          replayAuthorizationId: taskExecutionIntents.replayAuthorizationId,
        })
        .from(taskExecutionIntents)
        .where(eq(taskExecutionIntents.id, input.intentId))
        .limit(1)
      const intent = intents[0]
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
      const found = await tx
        .select()
        .from(taskExecutionEffects)
        .where(
          and(
            eq(taskExecutionEffects.executionLineageId, input.executionLineageId),
            eq(taskExecutionEffects.operationFamilyKey, input.operationFamilyKey),
            eq(taskExecutionEffects.operationGeneration, input.operationGeneration),
          ),
        )
        .limit(1)
      let effect = found[0]
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
        const watermarkRows = await tx
          .select()
          .from(taskExecutionLineageOperationRecords)
          .where(
            and(
              eq(taskExecutionLineageOperationRecords.recordKind, 'generation-watermark'),
              eq(taskExecutionLineageOperationRecords.executionLineageId, input.executionLineageId),
              eq(taskExecutionLineageOperationRecords.operationFamilyKey, input.operationFamilyKey),
            ),
          )
          .limit(1)
        const liveRows = await tx
          .select({ generation: max(taskExecutionEffects.operationGeneration) })
          .from(taskExecutionEffects)
          .where(
            and(
              eq(taskExecutionEffects.executionLineageId, input.executionLineageId),
              eq(taskExecutionEffects.operationFamilyKey, input.operationFamilyKey),
            ),
          )
        const watermark = watermarkRows[0]
        const highest = Math.max(
          watermark?.highestSettledGeneration ?? -1,
          liveRows[0]?.generation ?? -1,
        )
        if (input.operationGeneration !== highest + 1) {
          throw new TaskExecutionError(
            'task-continuation-stale',
            `operation generation ${input.operationGeneration} is not next after ${highest}`,
          )
        }
        const predecessorRows = await tx
          .select()
          .from(taskExecutionLineageOperationRecords)
          .where(
            and(
              eq(taskExecutionLineageOperationRecords.recordKind, 'replay-decision'),
              eq(taskExecutionLineageOperationRecords.executionLineageId, input.executionLineageId),
              eq(taskExecutionLineageOperationRecords.operationFamilyKey, input.operationFamilyKey),
              eq(
                taskExecutionLineageOperationRecords.operationGeneration,
                input.operationGeneration - 1,
              ),
            ),
          )
          .limit(1)
        const predecessor = predecessorRows[0]
        if (
          predecessor !== undefined &&
          (predecessor.decisionState !== 'actor-replay-authorized' ||
            predecessor.replayAuthorizationId !== intent.replayAuthorizationId ||
            predecessor.boundIntentId !== intent.id)
        ) {
          throw new TaskExecutionError(
            'task-execution-outcome-unknown',
            'the prior unknown operation has no matching actor replay authorization',
          )
        }
        const effectId = ulid()
        await tx
          .insert(taskExecutionEffects)
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
        const inserted = await tx
          .select()
          .from(taskExecutionEffects)
          .where(eq(taskExecutionEffects.id, effectId))
          .limit(1)
        effect = inserted[0]
        if (effect === undefined) throw new Error('effect insert did not materialize')
        if (predecessor !== undefined) {
          const consumed = await tx
            .update(taskExecutionLineageOperationRecords)
            .set({
              decisionState: 'consumed',
              boundIntentId: null,
              newEffectId: effectId,
              recordRevision: predecessor.recordRevision + 1,
              updatedAt: now,
            })
            .where(
              and(
                eq(taskExecutionLineageOperationRecords.id, predecessor.id),
                eq(taskExecutionLineageOperationRecords.recordRevision, predecessor.recordRevision),
                eq(taskExecutionLineageOperationRecords.decisionState, 'actor-replay-authorized'),
              ),
            )
            .returning({ id: taskExecutionLineageOperationRecords.id })
          if (consumed[0] === undefined) {
            throw new TaskExecutionError('task-continuation-stale', 'replay authorization changed')
          }
        }
      }

      const prior = await tx
        .select({
          attemptNo: taskExecutionEffectAttempts.attemptNo,
          state: taskExecutionEffectAttempts.state,
          applicationEvidence: taskExecutionEffectAttempts.applicationEvidence,
          retryAuthority: taskExecutionEffectAttempts.retryAuthority,
        })
        .from(taskExecutionEffectAttempts)
        .where(eq(taskExecutionEffectAttempts.effectId, effect.id))
        .orderBy(asc(taskExecutionEffectAttempts.attemptNo))
      const attemptNo = prior.length + 1
      if (prior.some((attempt, index) => attempt.attemptNo !== index + 1)) {
        throw new Error('non-monotonic persisted effect attempts')
      }
      const previous = prior.at(-1)
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
      await tx
        .insert(taskExecutionEffectAttempts)
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
          recoveryDescriptorJson,
          classifierVersion: input.classifierVersion,
          transportPolicyVersion: input.transportPolicyVersion,
          retryAuthority: input.retryAuthority,
          preparedAt: now,
          updatedAt: now,
        })
        .run()
      for (const fenceKey of resources) {
        try {
          await tx
            .insert(taskExecutionEffectFences)
            .values({
              effectAttemptId: attemptId,
              fenceKey,
              acquiredEpoch: input.token.epoch,
              acquiredAt: now,
            })
            .run()
        } catch (error) {
          if (!uniqueViolation(error)) throw error
          throw new TaskExecutionError(
            'task-execution-resource-conflict',
            `resource '${fenceKey}' is already held by another acting effect`,
            { resourceKey: fenceKey },
          )
        }
      }
      const acting = await tx
        .update(taskExecutionEffectAttempts)
        .set({ state: 'acting', actingAt: now, updatedAt: now })
        .where(
          and(
            eq(taskExecutionEffectAttempts.id, attemptId),
            eq(taskExecutionEffectAttempts.state, 'prepared'),
          ),
        )
        .returning({ id: taskExecutionEffectAttempts.id })
      const advanced = await tx
        .update(taskExecutionEffects)
        .set({ lastAttemptNo: attemptNo, currentIntentId: input.intentId, updatedAt: now })
        .where(
          and(
            eq(taskExecutionEffects.id, effect.id),
            eq(taskExecutionEffects.state, 'open'),
            eq(taskExecutionEffects.lastAttemptNo, attemptNo - 1),
          ),
        )
        .returning({ id: taskExecutionEffects.id })
      if (acting[0] === undefined || advanced[0] === undefined) {
        throw new TaskExecutionError('task-execution-stale-owner', 'effect preparation CAS lost')
      }
      return { effectId: effect.id, attemptId, attemptNo, resourceKeys: resources }
    })
  }

  private async settleTx(
    tx: PgTx,
    input: TaskEffectAttemptSettlement,
    projection?: CodeHostNodeSettlementProjection,
  ): Promise<void> {
    if (input.state === 'outcome-unknown') {
      throw new TaskExecutionError(
        'task-execution-recovery-required',
        'outcome-unknown requires a task-wide quiescence closure',
      )
    }
    const now = input.now ?? Date.now()
    await assertOwner(tx, input.token, now)
    const attemptRows = await tx
      .select()
      .from(taskExecutionEffectAttempts)
      .where(eq(taskExecutionEffectAttempts.id, input.attemptId))
      .limit(1)
    const effectRows = await tx
      .select()
      .from(taskExecutionEffects)
      .where(eq(taskExecutionEffects.id, input.effectId))
      .limit(1)
    const attempt = attemptRows[0]
    const effect = effectRows[0]
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
    const receiptJson = bounded(input.receiptJson)
    const changed = await tx
      .update(taskExecutionEffectAttempts)
      .set({
        state: input.state,
        applicationEvidence: input.applicationEvidence,
        retryAuthority: input.retryAuthority,
        receiptJson,
        failureCode: input.failureCode ?? null,
        settledAt:
          input.state === 'recovery-required' || input.state === 'retry-authorized' ? null : now,
        updatedAt: now,
      })
      .where(
        and(
          eq(taskExecutionEffectAttempts.id, attempt.id),
          eq(taskExecutionEffectAttempts.state, attempt.state),
          eq(taskExecutionEffectAttempts.epoch, input.token.epoch),
        ),
      )
      .returning({ id: taskExecutionEffectAttempts.id })
    if (changed[0] === undefined) {
      throw new TaskExecutionError('task-execution-stale-owner', 'effect settlement CAS lost')
    }
    if (input.state === 'retry-authorized') {
      await tx
        .update(taskExecutionEffectFences)
        .set({ releasedAt: now })
        .where(
          and(
            eq(taskExecutionEffectFences.effectAttemptId, attempt.id),
            isNull(taskExecutionEffectFences.releasedAt),
            eq(taskExecutionEffectFences.acquiredEpoch, input.token.epoch),
          ),
        )
        .run()
      if (projection !== undefined) await applyCodeHostProjection(tx, projection)
      return
    }
    if (input.state === 'recovery-required') {
      if (projection !== undefined) await applyCodeHostProjection(tx, projection)
      return
    }
    const attempts = await tx
      .select({
        attemptNo: taskExecutionEffectAttempts.attemptNo,
        state: taskExecutionEffectAttempts.state,
        applicationEvidence: taskExecutionEffectAttempts.applicationEvidence,
      })
      .from(taskExecutionEffectAttempts)
      .where(eq(taskExecutionEffectAttempts.effectId, effect.id))
      .orderBy(asc(taskExecutionEffectAttempts.attemptNo))
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
      await tx
        .update(taskExecutionEffectAttempts)
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
      if (projection !== undefined) await applyCodeHostProjection(tx, projection)
      return
    }
    await tx
      .update(taskExecutionEffectFences)
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
      lastAttemptReceipt: receiptJson === null ? null : JSON.parse(receiptJson),
    })
    const effectChanged = await tx
      .update(taskExecutionEffects)
      .set({
        state: outcome.state,
        receiptJson: logicalReceipt,
        failureCode: input.failureCode ?? null,
        settledAt: now,
        updatedAt: now,
      })
      .where(and(eq(taskExecutionEffects.id, effect.id), eq(taskExecutionEffects.state, 'open')))
      .returning({ id: taskExecutionEffects.id })
    if (effectChanged[0] === undefined) {
      throw new TaskExecutionError('task-execution-stale-owner', 'effect terminal CAS lost')
    }
    const watermarkRows = await tx
      .select()
      .from(taskExecutionLineageOperationRecords)
      .where(
        and(
          eq(taskExecutionLineageOperationRecords.recordKind, 'generation-watermark'),
          eq(taskExecutionLineageOperationRecords.executionLineageId, effect.executionLineageId),
          eq(taskExecutionLineageOperationRecords.operationFamilyKey, effect.operationFamilyKey),
        ),
      )
      .limit(1)
    const watermark = watermarkRows[0]
    if ((watermark?.highestSettledGeneration ?? -1) > effect.operationGeneration) {
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
      await tx
        .insert(taskExecutionLineageOperationRecords)
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
      const advanced = await tx
        .update(taskExecutionLineageOperationRecords)
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
        .returning({ id: taskExecutionLineageOperationRecords.id })
      if (advanced[0] === undefined) {
        throw new TaskExecutionError('task-execution-stale-owner', 'effect watermark CAS lost')
      }
    }
    if (projection !== undefined) await applyCodeHostProjection(tx, projection)
  }

  async settle(input: TaskEffectAttemptSettlement): Promise<void> {
    await serializable(this.db, async (tx) => await this.settleTx(tx, input))
  }

  /** Use-case-specific atom: effect settlement and review rollback projection
   * share one PostgreSQL transaction. It deliberately stays off the generic
   * application effect port. */
  async settleGateRollback(
    input: Parameters<GateContinuationEffectPersistence['settle']>[0],
  ): Promise<void> {
    if (input.outcome.kind === 'threw') {
      await this.settle({
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
    await serializable(this.db, async (tx) => {
      await this.settleTx(tx, {
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
      })
      if (input.sourceNodeRunIds.length === 0) return
      const rows = await tx
        .select({ id: nodeRuns.id, errorMessage: nodeRuns.errorMessage })
        .from(nodeRuns)
        .where(
          and(
            eq(nodeRuns.taskId, input.token.taskId),
            inArray(nodeRuns.id, [...input.sourceNodeRunIds]),
          ),
        )
        .limit(input.sourceNodeRunIds.length)
      if (rows.length !== input.sourceNodeRunIds.length) {
        throw new TaskExecutionError(
          'task-continuation-stale',
          `workspace rollback projection for '${input.operationId}' lost a source row`,
        )
      }
      const successful = new Set(outcome.successfulSourceNodeRunIds)
      for (const row of rows) {
        const rolledBack = successful.has(row.id)
        const updated = await tx
          .update(nodeRuns)
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
          .returning({ id: nodeRuns.id })
        if (updated[0] === undefined) {
          throw new TaskExecutionError(
            'task-continuation-stale',
            `workspace rollback projection for '${input.operationId}' lost source '${row.id}'`,
          )
        }
      }
    })
  }

  async settleCodeHostNode(
    input: Parameters<TaskExecutionEffectPersistence['settleCodeHostNode']>[0],
  ): Promise<void> {
    await serializable(
      this.db,
      async (tx) => await this.settleTx(tx, input.settlement, input.projection),
    )
  }

  async settleWorkspacePreparation(
    input: Parameters<TaskExecutionEffectPersistence['settleWorkspacePreparation']>[0],
  ): Promise<void> {
    await serializable(this.db, async (tx) => {
      await this.settleTx(tx, input.settlement)
      await tx
        .update(tasks)
        .set(input.projection.task)
        .where(eq(tasks.id, input.projection.taskId))
        .run()
      if (input.projection.repositories.length > 0) {
        await tx
          .insert(taskRepos)
          .values(input.projection.repositories.map((row) => ({ ...row })))
          .run()
      }
      if (input.projection.nodePaths.length > 0) {
        await tx
          .insert(taskSpaceNodes)
          .values(
            input.projection.nodePaths.map((nodePath) => ({
              taskId: input.projection.taskId,
              nodePath,
              schemaVersion: 1,
            })),
          )
          .run()
      }
      await createPostgresqlNodeRunLifecycleParticipantInTx(tx).set({
        nodeRunId: input.projection.prepNodeRunId,
        to: 'done',
        allowedFrom: ['running'],
        reason: 'repo-prep-done',
        extra: { finishedAt: input.projection.finishedAt },
      })
    })
  }

  async recordProcessSpawn(
    input: Parameters<TaskExecutionEffectPersistence['recordProcessSpawn']>[0],
  ): Promise<void> {
    const now = input.now ?? Date.now()
    await serializable(this.db, async (tx) => {
      await assertOwner(tx, input.token, now)
      const attempts = await tx
        .select({
          state: taskExecutionEffectAttempts.state,
          epoch: taskExecutionEffectAttempts.epoch,
          taskId: taskExecutionEffects.taskId,
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
        .limit(1)
      const attempt = attempts[0]
      if (
        attempt === undefined ||
        attempt.state !== 'acting' ||
        attempt.epoch !== input.token.epoch ||
        attempt.taskId !== input.token.taskId
      ) {
        throw new TaskExecutionError(
          'task-execution-stale-owner',
          `process attempt '${input.attemptId}' receipt was fenced`,
        )
      }
      const updated = await tx
        .update(taskExecutionEffectAttempts)
        .set({
          receiptJson: JSON.stringify({
            v: 1,
            phase: 'spawn-receipt',
            pid: input.pid,
            spawnBinaryPath: input.spawnBinaryPath,
            launchNonce: input.launchNonce,
          }),
          updatedAt: now,
        })
        .where(
          and(
            eq(taskExecutionEffectAttempts.id, input.attemptId),
            eq(taskExecutionEffectAttempts.state, 'acting'),
            eq(taskExecutionEffectAttempts.epoch, input.token.epoch),
          ),
        )
        .returning({ id: taskExecutionEffectAttempts.id })
      const projected = await tx
        .update(nodeRuns)
        .set({
          pid: input.pid,
          spawnBinaryPath: input.spawnBinaryPath,
          spawnLaunchNonce: input.launchNonce,
          ...(input.runtimeParamsJson === undefined
            ? {}
            : { runtimeParamsJson: input.runtimeParamsJson }),
        })
        .where(and(eq(nodeRuns.id, input.nodeRunId), eq(nodeRuns.taskId, input.token.taskId)))
        .returning({ id: nodeRuns.id })
      if (updated[0] === undefined || projected[0] === undefined) {
        throw new TaskExecutionError(
          'task-execution-stale-owner',
          'process spawn projection CAS lost',
        )
      }
    })
  }
}
