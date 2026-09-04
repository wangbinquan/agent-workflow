// RFC-349 — PostgreSQL successor-daemon effect/owner recovery.
//
// RFC-359 T7b：managed-process 清算与 outcome-unknown 闭合已收进 provider 中立的
// `effectQuiescence.ts`（两个引擎一份实现）；这里只剩 code-host 探针解析仍是 PG 私有形状
// （SQLite 侧对应 sqliteTaskExecutionEffect.ts 的同步版本，W4 pair-deletion 时合一）。

import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm'
import { ulid } from 'ulid'

import {
  nodeRunOutputs,
  nodeRuns,
  taskExecutionEffectAttempts,
  taskExecutionEffectFences,
  taskExecutionEffects,
  taskExecutionLineageOperationRecords,
  taskExecutionOwners,
} from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  TaskExecutionProcessRecoveryEvidence,
  TaskExecutionRecoveryFinalization,
  TaskExecutionRecoveryPersistence,
} from '../application/recoverTaskExecutions'
import { TaskExecutionError } from '../application/taskExecutionError'
import {
  codeHostRecoveryClass,
  decodeCodeHostRecoveryDescriptor,
  type CodeHostProbeOutcome,
  type CodeHostRecoveryDescriptor,
} from '../domain/codeHostRecovery'
import { sha256Hex } from '../domain/digest'
import {
  aggregateEffectOutcome,
  assertAttemptTransition,
  type AttemptEvidence,
} from '../domain/executionEffect'
import { canonicalJson } from '../domain/executionIntent'
import {
  assertExclusiveDaemonLockProof,
  createVerifiedOutcomeUnknownClosure,
  createVerifiedTakeoverProof,
  type OwnershipTuple,
} from '../domain/ownership'
import {
  closeRecoveredOutcomeUnknownAndRelease,
  readUnresolvedEffectIds,
  resolveQuiescedManagedProcesses,
} from './effectQuiescence'
import { PostgresqlTaskOwnershipPersistence } from './postgresqlTaskOwnershipPersistence'
import { retryPostgresqlSerialization } from '@/db/postgresqlSerializationRetry'

type PgTx = Parameters<Parameters<PostgresqlDatabaseClient['transaction']>[0]>[0]
type OwnerRow = typeof taskExecutionOwners.$inferSelect

const MAX_RECEIPT_BYTES = 64 * 1024

function tuple(row: OwnerRow): OwnershipTuple {
  return {
    taskId: row.taskId,
    ownerId: row.ownerId,
    daemonGeneration: row.daemonGeneration,
    epoch: row.epoch,
  }
}

async function serializable<T>(
  db: PostgresqlDatabaseClient,
  body: (tx: PgTx) => Promise<T>,
): Promise<T> {
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

function boundedReceipt(value: string): string {
  if (Buffer.byteLength(value) > MAX_RECEIPT_BYTES) {
    throw new Error('effect receipt exceeds the internal 64 KiB limit')
  }
  JSON.parse(value)
  return value
}

async function assertRecoveryOwner(
  tx: PgTx,
  owner: OwnershipTuple,
  expectedRevision: number,
): Promise<OwnerRow> {
  const rows = await tx
    .select()
    .from(taskExecutionOwners)
    .where(eq(taskExecutionOwners.taskId, owner.taskId))
    .limit(1)
  const current = rows[0]
  if (
    current === undefined ||
    current.ownerId !== owner.ownerId ||
    current.daemonGeneration !== owner.daemonGeneration ||
    current.epoch !== owner.epoch ||
    current.revision !== expectedRevision ||
    (current.state !== 'revoked' && current.state !== 'recovery-required')
  ) {
    throw new TaskExecutionError(
      'task-execution-stale-owner',
      `task '${owner.taskId}' recovery was fenced`,
    )
  }
  return current
}

async function upsertWatermark(
  tx: PgTx,
  effect: typeof taskExecutionEffects.$inferSelect,
  outcome: 'succeeded' | 'failed' | 'outcome-unknown',
  now: number,
): Promise<void> {
  const rows = await tx
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
  const watermark = rows[0]
  if ((watermark?.highestSettledGeneration ?? -1) > effect.operationGeneration) {
    throw new Error('recovered generation regressed below retained watermark')
  }
  if (
    watermark !== undefined &&
    watermark.highestSettledGeneration === effect.operationGeneration &&
    (watermark.requestHash !== effect.requestHash ||
      watermark.slotPathDigest !== effect.slotPathDigest)
  ) {
    throw new Error('recovered effect digest differs from retained watermark')
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
        lastOutcome: outcome,
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
    return
  }
  if ((watermark.highestSettledGeneration ?? -1) === effect.operationGeneration) return
  const updated = await tx
    .update(taskExecutionLineageOperationRecords)
    .set({
      highestSettledGeneration: effect.operationGeneration,
      lastOutcome: outcome,
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
  if (updated[0] === undefined) {
    throw new TaskExecutionError('task-execution-stale-owner', 'recovery watermark CAS lost')
  }
}

interface KnownCodeHostResolution {
  readonly effectId: string
  readonly attemptId: string
  readonly outcome: 'applied' | 'definitely-not-applied'
  readonly receiptJson: string
  readonly nodeRunId: string | null
  readonly responseStatus: number
  readonly responseBody: string
}

async function resolveCodeHostMutations(input: {
  db: PostgresqlDatabaseClient
  owner: OwnershipTuple
  expectedRevision: number
  quiescenceEvidenceDigest: string
  resolutions: readonly KnownCodeHostResolution[]
  now: number
}): Promise<
  Readonly<{ appliedEffectIds: readonly string[]; retryAuthorizedEffectIds: readonly string[] }>
> {
  return await serializable(input.db, async (tx) => {
    await assertRecoveryOwner(tx, input.owner, input.expectedRevision)
    const keys = new Set<string>()
    const applied: string[] = []
    const retryAuthorized: string[] = []
    for (const resolution of input.resolutions) {
      const key = `${resolution.effectId}\u0000${resolution.attemptId}`
      if (keys.has(key)) throw new Error('duplicate code-host recovery resolution')
      keys.add(key)
      if (
        !Number.isInteger(resolution.responseStatus) ||
        resolution.responseStatus < 100 ||
        resolution.responseStatus > 599
      ) {
        throw new Error('invalid code-host recovery response status')
      }
      const receiptJson = boundedReceipt(resolution.receiptJson)
      const rows = await tx
        .select({ attempt: taskExecutionEffectAttempts, effect: taskExecutionEffects })
        .from(taskExecutionEffectAttempts)
        .innerJoin(
          taskExecutionEffects,
          eq(taskExecutionEffects.id, taskExecutionEffectAttempts.effectId),
        )
        .where(eq(taskExecutionEffectAttempts.id, resolution.attemptId))
        .limit(1)
      const row = rows[0]
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
      let descriptor: CodeHostRecoveryDescriptor
      try {
        descriptor = decodeCodeHostRecoveryDescriptor(row.attempt.recoveryDescriptorJson)
      } catch {
        throw new TaskExecutionError(
          'task-execution-recovery-required',
          `code-host attempt '${row.attempt.id}' has no usable recovery descriptor`,
        )
      }
      const declaredClass = codeHostRecoveryClass(descriptor.action, descriptor.method)
      if (
        descriptor.probe.kind === 'actor-replay' ||
        declaredClass === 'R-ACTOR' ||
        declaredClass === 'R-READ' ||
        row.attempt.recoveryClass !== declaredClass ||
        !row.attempt.candidateId.startsWith(descriptor.candidateId) ||
        !/^:t[1-9]\d*$/.test(row.attempt.candidateId.slice(descriptor.candidateId.length)) ||
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
        const attempts = await tx
          .select({
            attemptNo: taskExecutionEffectAttempts.attemptNo,
            state: taskExecutionEffectAttempts.state,
            applicationEvidence: taskExecutionEffectAttempts.applicationEvidence,
          })
          .from(taskExecutionEffectAttempts)
          .where(eq(taskExecutionEffectAttempts.effectId, row.effect.id))
          .orderBy(asc(taskExecutionEffectAttempts.attemptNo))
        outcome = aggregateEffectOutcome(
          attempts.map(
            (attempt): AttemptEvidence =>
              attempt.attemptNo === row.attempt.attemptNo
                ? {
                    attemptNo: attempt.attemptNo,
                    state: 'succeeded',
                    applicationEvidence: 'applied',
                  }
                : {
                    attemptNo: attempt.attemptNo,
                    state: attempt.state,
                    applicationEvidence: attempt.applicationEvidence ?? 'ambiguous',
                  },
          ),
        )
        if (outcome.state !== 'succeeded') {
          throw new TaskExecutionError(
            'task-execution-recovery-required',
            `code-host attempt '${row.attempt.id}' did not produce a known applied outcome`,
          )
        }
      }
      const attemptUpdated = await tx
        .update(taskExecutionEffectAttempts)
        .set({
          state: nextState,
          applicationEvidence:
            resolution.outcome === 'applied' ? 'applied' : 'definitely-not-applied',
          retryAuthority: resolution.outcome === 'applied' ? 'none' : 'probe',
          receiptJson,
          failureCode:
            resolution.outcome === 'applied' ? null : 'code-host-probe-definitely-not-applied',
          settledAt: resolution.outcome === 'applied' ? input.now : null,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(taskExecutionEffectAttempts.id, row.attempt.id),
            eq(taskExecutionEffectAttempts.epoch, input.owner.epoch),
            eq(taskExecutionEffectAttempts.state, row.attempt.state),
          ),
        )
        .returning({ id: taskExecutionEffectAttempts.id })
      if (attemptUpdated[0] === undefined) {
        throw new TaskExecutionError('task-execution-stale-owner', 'code-host recovery CAS lost')
      }
      await tx
        .update(taskExecutionEffectFences)
        .set({ releasedAt: input.now })
        .where(
          and(
            eq(taskExecutionEffectFences.effectAttemptId, row.attempt.id),
            isNull(taskExecutionEffectFences.releasedAt),
            eq(taskExecutionEffectFences.acquiredEpoch, input.owner.epoch),
          ),
        )
        .run()
      if (resolution.outcome === 'definitely-not-applied') {
        retryAuthorized.push(row.effect.id)
        continue
      }
      if (outcome === null) throw new Error('applied code-host recovery lacks an outcome')
      const effectUpdated = await tx
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
          settledAt: input.now,
          updatedAt: input.now,
        })
        .where(
          and(eq(taskExecutionEffects.id, row.effect.id), eq(taskExecutionEffects.state, 'open')),
        )
        .returning({ id: taskExecutionEffects.id })
      if (effectUpdated[0] === undefined) {
        throw new TaskExecutionError('task-execution-stale-owner', 'code-host effect recovery lost')
      }
      await upsertWatermark(tx, row.effect, 'succeeded', input.now)
      if (resolution.nodeRunId !== null) {
        const runs = await tx
          .select({ status: nodeRuns.status })
          .from(nodeRuns)
          .where(
            and(eq(nodeRuns.id, resolution.nodeRunId), eq(nodeRuns.taskId, input.owner.taskId)),
          )
          .limit(1)
        if (
          runs[0] === undefined ||
          (runs[0].status !== 'interrupted' && runs[0].status !== 'running')
        ) {
          throw new Error(
            `code-host recovery node '${resolution.nodeRunId}' is not an interrupted run`,
          )
        }
        for (const value of [
          {
            nodeRunId: resolution.nodeRunId,
            portName: 'response',
            content: resolution.responseBody,
          },
          {
            nodeRunId: resolution.nodeRunId,
            portName: 'status',
            content: String(resolution.responseStatus),
          },
        ]) {
          await tx
            .insert(nodeRunOutputs)
            .values(value)
            .onConflictDoUpdate({
              target: [nodeRunOutputs.nodeRunId, nodeRunOutputs.portName],
              set: { content: value.content },
            })
            .run()
        }
        const projected = await tx
          .update(nodeRuns)
          .set({ status: 'done', finishedAt: input.now, errorMessage: null, failureCode: null })
          .where(
            and(
              eq(nodeRuns.id, resolution.nodeRunId),
              eq(nodeRuns.taskId, input.owner.taskId),
              inArray(nodeRuns.status, ['interrupted', 'running']),
            ),
          )
          .returning({ id: nodeRuns.id })
        if (projected[0] === undefined) {
          throw new Error(`code-host recovery node '${resolution.nodeRunId}' projection lost`)
        }
      }
      applied.push(row.effect.id)
    }
    return {
      appliedEffectIds: [...new Set(applied)].sort(),
      retryAuthorizedEffectIds: [...new Set(retryAuthorized)].sort(),
    }
  })
}

export class PostgresqlTaskExecutionRecoveryPersistence implements TaskExecutionRecoveryPersistence {
  private readonly ownership: PostgresqlTaskOwnershipPersistence

  constructor(private readonly db: PostgresqlDatabaseClient) {
    this.ownership = new PostgresqlTaskOwnershipPersistence(db)
  }

  async prepare(input: Parameters<TaskExecutionRecoveryPersistence['prepare']>[0]) {
    assertExclusiveDaemonLockProof(input.lockProof)
    const now = input.now ?? Date.now()
    const claims = await this.db
      .select()
      .from(taskExecutionOwners)
      .where(
        and(
          eq(taskExecutionOwners.state, 'claimed'),
          ne(taskExecutionOwners.daemonGeneration, input.lockProof.daemonGeneration),
        ),
      )
    const revokedTaskIds: string[] = []
    for (const owner of claims) {
      await this.ownership.revokeOldDaemon({
        owner: tuple(owner),
        expectedRevision: owner.revision,
        lockProof: input.lockProof,
        now,
      })
      revokedTaskIds.push(owner.taskId)
    }
    return { revokedTaskIds }
  }

  async finalize(
    input: Parameters<TaskExecutionRecoveryPersistence['finalize']>[0],
  ): Promise<TaskExecutionRecoveryFinalization> {
    assertExclusiveDaemonLockProof(input.lockProof)
    if (input.processEvidence.orphanReaperCompleted !== true) {
      throw new Error('task execution recovery requires a completed orphan-process barrier')
    }
    const now = input.now ?? Date.now()
    const candidates = await this.db
      .select()
      .from(taskExecutionOwners)
      .where(
        and(
          inArray(taskExecutionOwners.state, ['revoked', 'recovery-required']),
          ne(taskExecutionOwners.daemonGeneration, input.lockProof.daemonGeneration),
        ),
      )
    const releasedTaskIds: string[] = []
    const outcomeUnknownTaskIds: string[] = []
    const recoveredProcessEffectIds: string[] = []
    const recoveredCodeHostEffectIds: string[] = []
    const retryAuthorizedCodeHostEffectIds: string[] = []
    for (const owner of candidates) {
      const oldOwner = tuple(owner)
      const preResolution = await readUnresolvedEffectIds(this.db, owner.taskId)
      const processEvidenceDigest = sha256Hex(
        canonicalJson({
          v: 1,
          taskId: owner.taskId,
          oldOwner,
          successorGeneration: input.lockProof.daemonGeneration,
          lockReceiptDigest: input.lockProof.lockReceiptDigest,
          processEvidence: input.processEvidence,
          preResolutionEffectIds: preResolution,
        }),
      )
      const process = await resolveQuiescedManagedProcesses(this.db, {
        authority: 'successor-daemon',
        owner: oldOwner,
        expectedRevision: owner.revision,
        lockProof: input.lockProof,
        quiescenceEvidenceDigest: processEvidenceDigest,
        now,
      })
      recoveredProcessEffectIds.push(...process.resolvedEffectIds)

      const probeResults = await this.probeCodeHostCandidates(
        owner,
        input.codeHostProbe,
        input.processEvidence,
      )
      const codeHostEvidenceDigest = sha256Hex(
        canonicalJson({
          v: 1,
          taskId: owner.taskId,
          processEvidenceDigest,
          probeResults: probeResults.map((result) => ({
            effectId: result.effectId,
            attemptId: result.attemptId,
            outcome: result.outcome,
            nodeRunId: result.nodeRunId,
            responseStatus: result.responseStatus,
          })),
        }),
      )
      const codeHost = await resolveCodeHostMutations({
        db: this.db,
        owner: oldOwner,
        expectedRevision: owner.revision,
        quiescenceEvidenceDigest: codeHostEvidenceDigest,
        resolutions: probeResults,
        now,
      })
      recoveredCodeHostEffectIds.push(...codeHost.appliedEffectIds)
      retryAuthorizedCodeHostEffectIds.push(...codeHost.retryAuthorizedEffectIds)

      const unresolvedEffectIds = await readUnresolvedEffectIds(this.db, owner.taskId)
      const evidenceDigest = sha256Hex(
        canonicalJson({
          v: 2,
          taskId: owner.taskId,
          oldOwner,
          successorGeneration: input.lockProof.daemonGeneration,
          lockReceiptDigest: input.lockProof.lockReceiptDigest,
          processEvidenceDigest,
          recoveredProcessEffectIds: process.resolvedEffectIds,
          recoveredCodeHostEffectIds: codeHost.appliedEffectIds,
          retryAuthorizedCodeHostEffectIds: codeHost.retryAuthorizedEffectIds,
          codeHostEvidenceDigest,
          unresolvedEffectIds,
        }),
      )
      if (unresolvedEffectIds.length > 0) {
        await closeRecoveredOutcomeUnknownAndRelease(this.db, {
          owner: oldOwner,
          expectedRevision: owner.revision,
          lockProof: input.lockProof,
          proof: createVerifiedOutcomeUnknownClosure({
            taskId: owner.taskId,
            ownerRevision: owner.revision,
            epoch: owner.epoch,
            quiescenceDigest: evidenceDigest,
            unresolvedEffectIds,
            verifiedAt: now,
          }),
          now,
        })
        outcomeUnknownTaskIds.push(owner.taskId)
        continue
      }
      await this.ownership.releaseRecovered({
        owner: oldOwner,
        expectedRevision: owner.revision,
        proof: createVerifiedTakeoverProof({
          taskId: owner.taskId,
          oldOwnerRevision: owner.revision,
          oldEpoch: owner.epoch,
          evidenceDigest,
          verifiedAt: now,
        }),
        now,
      })
      releasedTaskIds.push(owner.taskId)
    }
    return {
      releasedTaskIds,
      outcomeUnknownTaskIds,
      recoveredProcessEffectIds: [...new Set(recoveredProcessEffectIds)].sort(),
      recoveredCodeHostEffectIds: [...new Set(recoveredCodeHostEffectIds)].sort(),
      retryAuthorizedCodeHostEffectIds: [...new Set(retryAuthorizedCodeHostEffectIds)].sort(),
    }
  }

  private async probeCodeHostCandidates(
    owner: OwnerRow,
    probe: ((descriptor: CodeHostRecoveryDescriptor) => Promise<CodeHostProbeOutcome>) | undefined,
    _processEvidence: TaskExecutionProcessRecoveryEvidence,
  ): Promise<readonly KnownCodeHostResolution[]> {
    const candidates = await this.db
      .select({
        effectId: taskExecutionEffects.id,
        attemptId: taskExecutionEffectAttempts.id,
        recoveryDescriptorJson: taskExecutionEffectAttempts.recoveryDescriptorJson,
      })
      .from(taskExecutionEffectAttempts)
      .innerJoin(
        taskExecutionEffects,
        eq(taskExecutionEffects.id, taskExecutionEffectAttempts.effectId),
      )
      .where(
        and(
          eq(taskExecutionEffects.taskId, owner.taskId),
          eq(taskExecutionEffects.kind, 'code-host-mutation'),
          eq(taskExecutionEffects.state, 'open'),
          eq(taskExecutionEffectAttempts.epoch, owner.epoch),
          inArray(taskExecutionEffectAttempts.state, ['acting', 'recovery-required']),
        ),
      )
      .orderBy(asc(taskExecutionEffects.id), asc(taskExecutionEffectAttempts.id))
    const results = await Promise.all(
      candidates.map(async (candidate): Promise<KnownCodeHostResolution | null> => {
        if (candidate.recoveryDescriptorJson === null || probe === undefined) return null
        let descriptor: CodeHostRecoveryDescriptor
        try {
          descriptor = decodeCodeHostRecoveryDescriptor(candidate.recoveryDescriptorJson)
        } catch {
          return null
        }
        if (descriptor.probe.kind === 'actor-replay') return null
        let outcome: CodeHostProbeOutcome
        try {
          outcome = await probe(descriptor)
        } catch {
          return null
        }
        if (outcome.kind === 'unknown') return null
        return {
          effectId: candidate.effectId,
          attemptId: candidate.attemptId,
          outcome: outcome.kind,
          receiptJson: JSON.stringify({
            v: 1,
            recovery: 'successor-daemon-code-host-probe',
            proofCode: outcome.proofCode,
            responseStatus: outcome.responseStatus,
          }),
          nodeRunId: descriptor.nodeRunId,
          responseStatus: outcome.responseStatus,
          responseBody: outcome.responseBody,
        }
      }),
    )
    return results.filter((result): result is KnownCodeHostResolution => result !== null)
  }
}
