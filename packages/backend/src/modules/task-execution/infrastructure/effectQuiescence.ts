// RFC-359 W1-T7b（P0-10）—— effect 静默清算的**一份**实现，两个引擎共用。
//
// 此前 SQLite 侧是 `sqliteTaskExecutionEffect.ts` 的同步 `resolveQuiescedManagedProcesses` /
// `closeOutcomeUnknownAndRelease`（dbTxSync），PostgreSQL 侧是 `postgresqlTaskExecutionRecovery.ts`
// 里只认 successor-daemon 权威的另一份 `resolveManagedProcesses` / `closeOutcomeUnknown`。
// 结果是 PostgreSQL 的驱动释放路径（exact-stop 权威）没有任何清算可调：`releaseAfterStop`
// 一看到还开着的 process effect 就抛 `task-execution-recovery-required`，每个跑过子进程的任务
// 都在 PG 上以 owner 卡死收场（dual-provider-parity-audit-2026-09-04 P0-10）。
//
// 这里只写一次：同一套证据判定（spawn receipt ↔ node_run 的 pid / launchNonce / binary）、
// 同一张 attempt 转移表、同一个 watermark / replay-decision 账本、同一个 owner 围栏。两种权威
// （exact-stop：本进程的 owner 拿着停机证明；successor-daemon：新一代 daemon 拿着独占锁证明）
// 只差「允许的 owner 状态」与「证明如何对上 owner」，都在 `resolveQuiescenceAuthority` 里判完再进事务。
//
// 事务形状按 RFC-359 §5：READ COMMITTED + 聚合根行锁（owner 行 `FOR UPDATE`；SQLite 上
// BEGIN IMMEDIATE 已独占，锁是 no-op）。不用 SERIALIZABLE——这些原子只在 runtime 已停 / 旧 daemon
// 已撤销之后跑，没有并发 worker 要用谓词锁去挡。

import { and, asc, eq, inArray, isNull, like } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import {
  nodeRuns,
  taskExecutionEffectAttempts,
  taskExecutionEffectFences,
  taskExecutionEffects,
  taskExecutionIntents,
  taskExecutionLineageOperationRecords,
  taskExecutionOwners,
} from '@/db/schema'
import {
  databaseSessionFor,
  engineOf,
  type DatabaseTransaction,
} from '@/platform/persistence/databaseTransaction'
import type {
  ManagedProcessQuiescenceAuthority,
  ManagedProcessQuiescenceInput,
  RecoveredManagedProcessResolution,
} from '../application/ports/taskExecutionEffectStore'
import { TaskExecutionError } from '../application/taskExecutionError'
import type { TerminalizeTaskExecutionIntentsInput } from '../application/terminalizeExecutionIntent'
import {
  aggregateEffectOutcome,
  assertAttemptTransition,
  type AttemptEvidence,
} from '../domain/executionEffect'
import {
  assertExclusiveDaemonLockProof,
  assertOwnershipToken,
  assertVerifiedOutcomeUnknownClosure,
  assertVerifiedStopProof,
  ownershipTuple,
  type ExclusiveDaemonLockProof,
  type OwnerSnapshot,
  type OwnershipToken,
  type OwnershipTuple,
  type TaskOwnerState,
  type VerifiedOutcomeUnknownClosure,
} from '../domain/ownership'

/** RFC-328 pre-activated managed-process attempts are the only shape a quiescence barrier may settle. */
export const MANAGED_PROCESS_RECOVERY_CLASS = 'managed-process-preactivation'

/** Attempt states that still hold the effect open (and its resource fences). */
export const UNRESOLVED_ATTEMPT_STATES = ['prepared', 'acting', 'recovery-required'] as const

type OwnerRow = typeof taskExecutionOwners.$inferSelect
type EffectRow = typeof taskExecutionEffects.$inferSelect
type AttemptRow = typeof taskExecutionEffectAttempts.$inferSelect

export interface ResolvedQuiescenceAuthority {
  readonly owner: OwnershipTuple
  readonly expectedRevision: number
  readonly allowedOwnerStates: readonly TaskOwnerState[]
}

/** 证明对上 owner 的纯判定；不碰库。两种权威的差异全部收在这里。 */
export function resolveQuiescenceAuthority(
  input: ManagedProcessQuiescenceAuthority,
): ResolvedQuiescenceAuthority {
  if (input.authority === 'successor-daemon') {
    assertExclusiveDaemonLockProof(input.lockProof)
    if (input.lockProof.daemonGeneration === input.owner.daemonGeneration) {
      throw new Error('managed-process successor recovery requires a new daemon generation')
    }
    return {
      owner: input.owner,
      expectedRevision: input.expectedRevision,
      allowedOwnerStates: ['revoked', 'recovery-required'],
    }
  }
  assertOwnershipToken(input.token)
  assertVerifiedStopProof(input.proof)
  if (
    input.proof.taskId !== input.token.taskId ||
    input.proof.epoch !== input.token.epoch ||
    input.proof.ownerRevision !== input.expectedRevision
  ) {
    throw new Error('managed-process stop proof does not match the exact owner')
  }
  return {
    owner: ownershipTuple(input.token),
    expectedRevision: input.expectedRevision,
    allowedOwnerStates: ['claimed', 'revoked', 'recovery-required'],
  }
}

export function parseJsonRecord(value: string | null): Readonly<Record<string, unknown>> | null {
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

/**
 * 一条 pre-activated process attempt 在 runtime 静默后能不能被判定。
 * 有 durable spawn receipt 且与 node_run 的 pid / launchNonce / binary 全部对上 ⇒ applied；
 * 没有 receipt 且 attempt 还停在 prepared / acting ⇒ 门控启动器根本没激活目标 ⇒ definitely-not-applied；
 * 其余形状（run 还在跑、receipt 与 run 不符……）一律 null，留给 outcome-unknown 闭合。
 */
export function recoveredManagedProcessEvidence(input: {
  readonly attemptState: AttemptRow['state']
  readonly receiptJson: string | null
  readonly run: typeof nodeRuns.$inferSelect
}): 'applied' | 'definitely-not-applied' | null {
  if (input.run.status === 'pending' || input.run.status === 'running') return null
  if (input.receiptJson === null) {
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

function ownerSnapshot(row: OwnerRow): OwnerSnapshot {
  return {
    taskId: row.taskId,
    ownerId: row.ownerId,
    daemonGeneration: row.daemonGeneration,
    epoch: row.epoch,
    state: row.state,
    leaseUntil: row.leaseUntil,
    revision: row.revision,
  }
}

/** 锁住 owner 行并按元组 / revision / 允许状态围栏。所有清算原子的第一步。 */
async function lockAndAssertOwnerTx(
  tx: DatabaseTransaction,
  owner: OwnershipTuple,
  expectedRevision: number,
  allowedStates: readonly TaskOwnerState[],
  fencedMessage: string,
): Promise<OwnerRow> {
  await engineOf(tx).lockAggregateRoot(
    tx,
    taskExecutionOwners,
    taskExecutionOwners.taskId,
    owner.taskId,
  )
  const current = (
    await tx
      .select()
      .from(taskExecutionOwners)
      .where(eq(taskExecutionOwners.taskId, owner.taskId))
      .limit(1)
  )[0]
  if (
    current === undefined ||
    current.ownerId !== owner.ownerId ||
    current.daemonGeneration !== owner.daemonGeneration ||
    current.epoch !== owner.epoch ||
    current.revision !== expectedRevision ||
    !allowedStates.includes(current.state)
  ) {
    throw new TaskExecutionError('task-execution-stale-owner', fencedMessage)
  }
  return current
}

async function loadUnresolvedAttemptsTx(
  tx: DatabaseTransaction,
  taskId: string,
  kind?: EffectRow['kind'],
): Promise<readonly { readonly attempt: AttemptRow; readonly effect: EffectRow }[]> {
  return await tx
    .select({ attempt: taskExecutionEffectAttempts, effect: taskExecutionEffects })
    .from(taskExecutionEffectAttempts)
    .innerJoin(
      taskExecutionEffects,
      eq(taskExecutionEffects.id, taskExecutionEffectAttempts.effectId),
    )
    .where(
      and(
        eq(taskExecutionEffects.taskId, taskId),
        ...(kind === undefined ? [] : [eq(taskExecutionEffects.kind, kind)]),
        eq(taskExecutionEffects.state, 'open'),
        inArray(taskExecutionEffectAttempts.state, [...UNRESOLVED_ATTEMPT_STATES]),
      ),
    )
    .orderBy(
      asc(taskExecutionEffects.operationGeneration),
      asc(taskExecutionEffectAttempts.attemptNo),
    )
}

/** effect ids that still have a prepared / acting / recovery-required attempt. Works on a client or a tx. */
export async function readUnresolvedEffectIds(
  db: ProviderNeutralDatabase,
  taskId: string,
): Promise<readonly string[]> {
  const rows = await db
    .select({ effectId: taskExecutionEffects.id })
    .from(taskExecutionEffectAttempts)
    .innerJoin(
      taskExecutionEffects,
      eq(taskExecutionEffects.id, taskExecutionEffectAttempts.effectId),
    )
    .where(
      and(
        eq(taskExecutionEffects.taskId, taskId),
        eq(taskExecutionEffects.state, 'open'),
        inArray(taskExecutionEffectAttempts.state, [...UNRESOLVED_ATTEMPT_STATES]),
      ),
    )
  return [...new Set(rows.map((row) => row.effectId))].sort()
}

/**
 * runtime 停机时无法回收的子进程证据。node_run 行上留着 `child-unkillable` 就不能宣告干净停机——
 * owner 只能进 recovery-required，交给 successor-daemon 的孤儿收割屏障。
 */
export async function readUnreapedProcessCode(
  db: ProviderNeutralDatabase,
  taskId: string,
): Promise<string | null> {
  const row = (
    await db
      .select({ errorMessage: nodeRuns.errorMessage })
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), like(nodeRuns.errorMessage, '%child-unkillable%')))
      .limit(1)
  )[0]
  return row === undefined ? null : 'child-unkillable'
}

async function upsertWatermarkTx(
  tx: DatabaseTransaction,
  effect: EffectRow,
  outcome: 'succeeded' | 'failed' | 'outcome-unknown',
  now: number,
): Promise<void> {
  const watermark = (
    await tx
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
  )[0]
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
  const updated = await tx
    .update(taskExecutionLineageOperationRecords)
    .set({
      highestSettledGeneration: Math.max(
        watermark.highestSettledGeneration ?? -1,
        effect.operationGeneration,
      ),
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

async function releaseAttemptFencesTx(
  tx: DatabaseTransaction,
  attemptId: string,
  epoch: number,
  now: number,
): Promise<void> {
  await tx
    .update(taskExecutionEffectFences)
    .set({ releasedAt: now })
    .where(
      and(
        eq(taskExecutionEffectFences.effectAttemptId, attemptId),
        isNull(taskExecutionEffectFences.releasedAt),
        eq(taskExecutionEffectFences.acquiredEpoch, epoch),
      ),
    )
    .run()
}

/**
 * 清算 RFC-328 的 pre-activated managed-process attempt：有 spawn receipt 的按 node_run 终态判
 * applied，没 receipt 的判 definitely-not-applied；其余形状原样留在 unresolvedEffectIds 里。
 * 调用方先用 `resolveQuiescenceAuthority` 判完权威再进事务。
 */
async function resolveManagedProcessesTx(input: {
  readonly tx: DatabaseTransaction
  readonly owner: OwnershipTuple
  readonly quiescenceEvidenceDigest: string
  readonly now: number
}): Promise<RecoveredManagedProcessResolution> {
  const { tx, owner, now } = input
  const rows = await loadUnresolvedAttemptsTx(tx, owner.taskId, 'process')
  const countByEffect = new Map<string, number>()
  for (const row of rows) {
    countByEffect.set(row.effect.id, (countByEffect.get(row.effect.id) ?? 0) + 1)
  }
  const resolved = new Set<string>()
  const unresolved = new Set<string>()
  for (const { attempt, effect } of rows) {
    if (
      countByEffect.get(effect.id) !== 1 ||
      attempt.epoch !== owner.epoch ||
      attempt.recoveryClass !== MANAGED_PROCESS_RECOVERY_CLASS
    ) {
      unresolved.add(effect.id)
      continue
    }
    const candidate = /^(agent|script):(.+)$/.exec(attempt.candidateId)
    if (candidate === null) {
      unresolved.add(effect.id)
      continue
    }
    const run = (
      await tx
        .select()
        .from(nodeRuns)
        .where(and(eq(nodeRuns.id, candidate[2]!), eq(nodeRuns.taskId, owner.taskId)))
        .limit(1)
    )[0]
    if (run === undefined) {
      unresolved.add(effect.id)
      continue
    }
    const applicationEvidence = recoveredManagedProcessEvidence({
      attemptState: attempt.state,
      receiptJson: attempt.receiptJson,
      run,
    })
    if (applicationEvidence === null) {
      unresolved.add(effect.id)
      continue
    }
    const attemptState = applicationEvidence === 'applied' ? 'succeeded' : 'failed-not-applied'
    assertAttemptTransition(attempt.state, attemptState)
    const attemptRows = await tx
      .select({
        attemptNo: taskExecutionEffectAttempts.attemptNo,
        state: taskExecutionEffectAttempts.state,
        applicationEvidence: taskExecutionEffectAttempts.applicationEvidence,
      })
      .from(taskExecutionEffectAttempts)
      .where(eq(taskExecutionEffectAttempts.effectId, effect.id))
      .orderBy(asc(taskExecutionEffectAttempts.attemptNo))
    const projected: AttemptEvidence[] = attemptRows.map((row) =>
      row.attemptNo === attempt.attemptNo
        ? { attemptNo: row.attemptNo, state: attemptState, applicationEvidence }
        : {
            attemptNo: row.attemptNo,
            state: row.state,
            applicationEvidence: row.applicationEvidence ?? 'ambiguous',
          },
    )
    let outcome: ReturnType<typeof aggregateEffectOutcome>
    try {
      outcome = aggregateEffectOutcome(projected)
    } catch {
      unresolved.add(effect.id)
      continue
    }
    if (outcome.state === 'outcome-unknown') {
      unresolved.add(effect.id)
      continue
    }
    const failureCode =
      applicationEvidence === 'definitely-not-applied'
        ? 'daemon-restart-before-process-activation'
        : null
    const attemptUpdated = await tx
      .update(taskExecutionEffectAttempts)
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
          eq(taskExecutionEffectAttempts.epoch, owner.epoch),
          eq(taskExecutionEffectAttempts.state, attempt.state),
        ),
      )
      .returning({ id: taskExecutionEffectAttempts.id })
    if (attemptUpdated[0] === undefined) {
      throw new TaskExecutionError('task-execution-stale-owner', 'process recovery CAS lost')
    }
    await releaseAttemptFencesTx(tx, attempt.id, owner.epoch, now)
    const effectUpdated = await tx
      .update(taskExecutionEffects)
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
          priorReceipt: attempt.receiptJson === null ? null : parseJsonRecord(attempt.receiptJson),
        }),
        settledAt: now,
        updatedAt: now,
      })
      .where(and(eq(taskExecutionEffects.id, effect.id), eq(taskExecutionEffects.state, 'open')))
      .returning({ id: taskExecutionEffects.id })
    if (effectUpdated[0] === undefined) {
      throw new TaskExecutionError('task-execution-stale-owner', 'process effect recovery CAS lost')
    }
    await upsertWatermarkTx(tx, effect, outcome.state, now)
    resolved.add(effect.id)
    unresolved.delete(effect.id)
  }
  return {
    resolvedEffectIds: [...resolved].sort(),
    unresolvedEffectIds: [...unresolved].sort(),
  }
}

/** Resolve pre-activated managed-process attempts after the task's runtime went quiet. */
export async function resolveQuiescedManagedProcesses(
  db: ProviderNeutralDatabase,
  input: ManagedProcessQuiescenceInput,
): Promise<RecoveredManagedProcessResolution> {
  if (input.quiescenceEvidenceDigest.length === 0) {
    throw new Error('managed-process recovery requires quiescence evidence')
  }
  const authority = resolveQuiescenceAuthority(input)
  const now = input.now ?? Date.now()
  return await databaseSessionFor(db).transaction(async (tx) => {
    await lockAndAssertOwnerTx(
      tx,
      authority.owner,
      authority.expectedRevision,
      authority.allowedOwnerStates,
      `task '${authority.owner.taskId}' managed-process recovery was fenced`,
    )
    return await resolveManagedProcessesTx({
      tx,
      owner: authority.owner,
      quiescenceEvidenceDigest: input.quiescenceEvidenceDigest,
      now,
    })
  })
}

/**
 * Close every active intent of one task and hand any unconsumed replay authorization back to
 * requires-actor, inside the caller's control / recovery transaction. Successor-daemon recovery
 * can fence this to the interrupted claimed epoch so a gate decision committed before the crash
 * keeps its pending successor.
 */
export async function terminalizeTaskExecutionIntentsTx(
  tx: DatabaseTransaction,
  input: TerminalizeTaskExecutionIntentsInput,
): Promise<void> {
  const active = await tx
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
  const activeIntentIds = active.map((row) => row.id)
  if (activeIntentIds.length === 0) return
  const terminalized = await tx
    .update(taskExecutionIntents)
    .set({
      state: input.state,
      failureCode: input.failureCode,
      completedAt: input.now,
      updatedAt: input.now,
    })
    .where(inArray(taskExecutionIntents.id, activeIntentIds))
    .returning({ id: taskExecutionIntents.id })
  if (terminalized.length !== activeIntentIds.length) {
    throw new TaskExecutionError(
      'task-continuation-stale',
      `task '${input.taskId}' active intents changed during terminalization`,
    )
  }
  const decisions = await tx
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
  for (const decision of decisions) {
    const released = await tx
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
      .returning({ id: taskExecutionLineageOperationRecords.id })
    if (released[0] === undefined) {
      throw new TaskExecutionError(
        'task-continuation-stale',
        `replay decision '${decision.id}' changed during intent terminalization`,
      )
    }
  }
}

/**
 * Terminalize an ambiguous execution generation only after a task-wide quiescence proof exists:
 * every still-open attempt becomes outcome-unknown, its fences release, the lineage keeps a
 * requires-actor replay decision, active intents fail and the owner row is released. A
 * response-loss path may mark recovery-required by itself, but it can never release resource
 * holds or the owner — that is exactly what this closure is for.
 */
async function closeOutcomeUnknownAndReleaseTx(input: {
  readonly tx: DatabaseTransaction
  readonly owner: OwnerRow
  readonly proof: VerifiedOutcomeUnknownClosure
  readonly allowedOwnerStates: readonly TaskOwnerState[]
  readonly now: number
}): Promise<OwnerSnapshot> {
  const { tx, owner, now } = input
  const unresolved = await loadUnresolvedAttemptsTx(tx, owner.taskId)
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
    const failureCode = attempt.failureCode ?? 'outcome-unknown-after-quiescence'
    const attemptUpdated = await tx
      .update(taskExecutionEffectAttempts)
      .set({
        state: 'outcome-unknown',
        applicationEvidence: 'ambiguous',
        retryAuthority: 'none',
        failureCode,
        settledAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(taskExecutionEffectAttempts.id, attempt.id),
          eq(taskExecutionEffectAttempts.epoch, owner.epoch),
          inArray(taskExecutionEffectAttempts.state, [...UNRESOLVED_ATTEMPT_STATES]),
        ),
      )
      .returning({ id: taskExecutionEffectAttempts.id })
    if (attemptUpdated[0] === undefined) {
      throw new TaskExecutionError('task-execution-stale-owner', 'outcome closure attempt CAS lost')
    }
    await releaseAttemptFencesTx(tx, attempt.id, owner.epoch, now)
    const effectUpdated = await tx
      .update(taskExecutionEffects)
      .set({
        state: 'outcome-unknown',
        failureCode,
        receiptJson: JSON.stringify({
          v: 1,
          closureDigest: input.proof.quiescenceDigest,
          attemptId: attempt.id,
          attemptNo: attempt.attemptNo,
        }),
        settledAt: now,
        updatedAt: now,
      })
      .where(and(eq(taskExecutionEffects.id, effect.id), eq(taskExecutionEffects.state, 'open')))
      .returning({ id: taskExecutionEffects.id })
    if (effectUpdated[0] === undefined) {
      throw new TaskExecutionError('task-execution-stale-owner', 'outcome closure effect CAS lost')
    }
    await upsertWatermarkTx(tx, effect, 'outcome-unknown', now)
    const decision = (
      await tx
        .select({ id: taskExecutionLineageOperationRecords.id })
        .from(taskExecutionLineageOperationRecords)
        .where(
          and(
            eq(taskExecutionLineageOperationRecords.recordKind, 'replay-decision'),
            eq(taskExecutionLineageOperationRecords.executionLineageId, effect.executionLineageId),
            eq(taskExecutionLineageOperationRecords.operationFamilyKey, effect.operationFamilyKey),
            eq(
              taskExecutionLineageOperationRecords.operationGeneration,
              effect.operationGeneration,
            ),
          ),
        )
        .limit(1)
    )[0]
    if (decision === undefined) {
      await tx
        .insert(taskExecutionLineageOperationRecords)
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
          failureCode,
          decisionState: 'requires-actor',
          recordRevision: 1,
          createdAt: now,
          updatedAt: now,
        })
        .run()
    }
  }
  await terminalizeTaskExecutionIntentsTx(tx, {
    taskId: owner.taskId,
    state: 'failed',
    failureCode: 'task-execution-outcome-unknown',
    now,
  })
  const released = await tx
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
        eq(taskExecutionOwners.taskId, owner.taskId),
        eq(taskExecutionOwners.ownerId, owner.ownerId),
        eq(taskExecutionOwners.daemonGeneration, owner.daemonGeneration),
        eq(taskExecutionOwners.epoch, owner.epoch),
        eq(taskExecutionOwners.revision, owner.revision),
        inArray(taskExecutionOwners.state, [...input.allowedOwnerStates]),
      ),
    )
    .returning()
  const row = released[0]
  if (row === undefined) {
    throw new TaskExecutionError(
      'task-execution-stale-owner',
      `task '${owner.taskId}' outcome-unknown release lost`,
    )
  }
  return ownerSnapshot(row)
}

/** Exact-owner closure: the process-local driver proves task-wide quiescence with its own token. */
export async function closeOutcomeUnknownAndRelease(
  db: ProviderNeutralDatabase,
  input: {
    readonly token: OwnershipToken
    readonly intentId: string
    readonly proof: VerifiedOutcomeUnknownClosure
    readonly now?: number
  },
): Promise<OwnerSnapshot> {
  assertOwnershipToken(input.token)
  assertVerifiedOutcomeUnknownClosure(input.proof)
  if (input.proof.taskId !== input.token.taskId || input.proof.epoch !== input.token.epoch) {
    throw new Error('outcome-unknown closure does not match ownership token')
  }
  const allowedOwnerStates: readonly TaskOwnerState[] = ['claimed', 'revoked', 'recovery-required']
  const now = input.now ?? Date.now()
  return await databaseSessionFor(db).transaction(async (tx) => {
    const owner = await lockAndAssertOwnerTx(
      tx,
      ownershipTuple(input.token),
      input.proof.ownerRevision,
      allowedOwnerStates,
      `task '${input.token.taskId}' outcome-unknown closure was fenced`,
    )
    return await closeOutcomeUnknownAndReleaseTx({
      tx,
      owner,
      proof: input.proof,
      allowedOwnerStates,
      now,
    })
  })
}

/** Successor-daemon closure: a new daemon generation closes the old owner's ambiguous generation. */
export async function closeRecoveredOutcomeUnknownAndRelease(
  db: ProviderNeutralDatabase,
  input: {
    readonly owner: OwnershipTuple
    readonly expectedRevision: number
    readonly lockProof: ExclusiveDaemonLockProof
    readonly proof: VerifiedOutcomeUnknownClosure
    readonly now?: number
  },
): Promise<OwnerSnapshot> {
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
  const allowedOwnerStates: readonly TaskOwnerState[] = ['revoked', 'recovery-required']
  const now = input.now ?? Date.now()
  return await databaseSessionFor(db).transaction(async (tx) => {
    const owner = await lockAndAssertOwnerTx(
      tx,
      input.owner,
      input.expectedRevision,
      allowedOwnerStates,
      `task '${input.owner.taskId}' recovery was fenced`,
    )
    return await closeOutcomeUnknownAndReleaseTx({
      tx,
      owner,
      proof: input.proof,
      allowedOwnerStates,
      now,
    })
  })
}
