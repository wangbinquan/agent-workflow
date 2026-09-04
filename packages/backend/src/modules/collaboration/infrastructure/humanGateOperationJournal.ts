// RFC-359 —— human-gate 操作日志（collaboration_gate_operations / _artifacts）的**唯一**事务内实现。
//
// 以前 SQLite 侧是 `sqliteHumanGateOperationStore.ts`（同步、接 dbTxSync 事务；过渡期保留给尚未
// 迁移的同步调用方），PostgreSQL 侧是 `postgresqlHumanGateOperationPersistence.ts`（每个方法自开
// SERIALIZABLE 事务，**无法**参与调用方的事务——问题写入与 gate 操作永远做不到同一事务原子）。
// 两份逻辑逐字相同，这里是唯一的 async 版本：接调用方 `DatabaseSession.transaction` 里的 `tx`。
//
// 按能力提需求的三处：
//   · `beginTx` 先锁任务聚合根——「查重放 / 查活跃操作 / 插入」是先读后写，PostgreSQL READ COMMITTED
//     下两个并发 begin 会各自读到「没有」再各自插入（唯一索引只能兜住其中一个）；SQLite 独占事务 no-op；
//   · 恢复认领的排序用 `ascNullsFirst`：从未被认领过的操作（claim_expires_at IS NULL）要排在最前，
//     PostgreSQL 缺省把 NULL 排最后，过期认领一旦填满 LIMIT，新操作就再也轮不到（RFC-349 实测）；
//   · CAS 的受影响行数走 `affectedRows`。

import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, ne, or } from 'drizzle-orm'

import { collaborationGateArtifacts, collaborationGateOperations, tasks } from '@/db/schema'
import {
  affectedRows,
  engineOf,
  type DatabaseTransaction,
} from '@/platform/persistence/databaseTransaction'
import type { CanonicalHumanGateRequest } from '../domain/canonicalGateRequest'
import {
  canonicalHumanGateJson,
  canonicalHumanGateRequestHash,
} from '../domain/canonicalGateRequest'
import {
  assertHumanGateIdempotencyMatch,
  assertHumanGateManifestJson,
  assertHumanGateOperationTransition,
  HumanGateOperationError,
  type HumanGateArtifactState,
  type HumanGateOperationSnapshot,
} from '../domain/humanGateOperation'
import {
  DEFAULT_HUMAN_GATE_CLAIM_LEASE_MS,
  type BegunHumanGateOperation,
  type HumanGateArtifactDeclaration,
  type HumanGateArtifactSnapshot,
} from './humanGateOperationTransactionStore'

type OperationRow = typeof collaborationGateOperations.$inferSelect
type ArtifactRow = typeof collaborationGateArtifacts.$inferSelect

const ACTIVE_OPERATION_STATES = ['preparing', 'prepared', 'committed', 'cleanup_pending'] as const

const ARTIFACT_TRANSITIONS = {
  declared: ['staged', 'cleanup_pending'],
  staged: ['consumed', 'cleanup_pending'],
  consumed: ['finalized', 'cleanup_pending'],
  finalized: [],
  cleanup_pending: [],
} as const satisfies Record<HumanGateArtifactState, readonly HumanGateArtifactState[]>

export interface BeginHumanGateOperationJournalInput {
  readonly tx: DatabaseTransaction
  readonly operationId: string
  readonly request: CanonicalHumanGateRequest
  readonly idempotencyKey: string
  readonly now: number
}

/** 事务内的 human-gate 操作日志。方法名沿用 `*Tx` 后缀：它们跑在调用方的事务里，不自开事务。 */
export interface HumanGateOperationJournal {
  beginTx(input: BeginHumanGateOperationJournalInput): Promise<BegunHumanGateOperation>
  findByIdempotencyTx(input: {
    readonly tx: DatabaseTransaction
    readonly taskId: string
    readonly gateKind: CanonicalHumanGateRequest['gateKind']
    readonly operationKind: CanonicalHumanGateRequest['operationKind']
    readonly idempotencyKey: string
  }): Promise<HumanGateOperationSnapshot | null>
  latestGateRevisionTx(input: {
    readonly tx: DatabaseTransaction
    readonly gateKind: CanonicalHumanGateRequest['gateKind']
    readonly gateRef: string
  }): Promise<number>
  getTx(tx: DatabaseTransaction, operationId: string): Promise<HumanGateOperationSnapshot | null>
  listArtifactsTx(
    tx: DatabaseTransaction,
    operationId: string,
  ): Promise<readonly HumanGateArtifactSnapshot[]>
  claimRecoveryBatchTx(input: {
    readonly tx: DatabaseTransaction
    readonly now: number
    readonly leaseMs: number
    readonly limit: number
  }): Promise<readonly HumanGateOperationSnapshot[]>
  renewRecoveryClaimTx(input: {
    readonly tx: DatabaseTransaction
    readonly operationId: string
    readonly expectedClaimEpoch: number
    readonly now: number
    readonly leaseMs: number
  }): Promise<HumanGateOperationSnapshot>
  markPreparedTx(input: {
    readonly tx: DatabaseTransaction
    readonly operationId: string
    readonly expectedClaimEpoch: number
    readonly manifestJson: string
    readonly now: number
  }): Promise<HumanGateOperationSnapshot>
  commitTx(input: {
    readonly tx: DatabaseTransaction
    readonly operationId: string
    readonly expectedClaimEpoch: number
    readonly receiptJson: string
    readonly now: number
  }): Promise<HumanGateOperationSnapshot>
  completeTx(input: {
    readonly tx: DatabaseTransaction
    readonly operationId: string
    readonly expectedClaimEpoch: number
    readonly now: number
  }): Promise<HumanGateOperationSnapshot>
  markCleanupPendingTx(input: {
    readonly tx: DatabaseTransaction
    readonly operationId: string
    readonly expectedClaimEpoch: number
    readonly now: number
  }): Promise<HumanGateOperationSnapshot>
  deleteCleanupArtifactsTx(input: {
    readonly tx: DatabaseTransaction
    readonly operationId: string
    readonly expectedClaimEpoch: number
  }): Promise<void>
  completeCleanupTx(input: {
    readonly tx: DatabaseTransaction
    readonly operationId: string
    readonly expectedClaimEpoch: number
    readonly failureJson: string
    readonly now: number
  }): Promise<HumanGateOperationSnapshot>
  declareArtifactsTx(input: {
    readonly tx: DatabaseTransaction
    readonly operationId: string
    readonly artifacts: readonly HumanGateArtifactDeclaration[]
    readonly now: number
  }): Promise<void>
  transitionArtifactTx(input: {
    readonly tx: DatabaseTransaction
    readonly operationId: string
    readonly artifactKey: string
    readonly from: HumanGateArtifactState
    readonly to: HumanGateArtifactState
    readonly receiptJson?: string | null
    readonly expectedClaimEpoch?: number
    readonly now: number
  }): Promise<void>
}

function snapshot(row: OperationRow): HumanGateOperationSnapshot {
  return {
    id: row.id,
    taskId: row.taskId,
    gateKind: row.gateKind,
    operationKind: row.operationKind,
    gateRef: row.gateRef,
    idempotencyKey: row.idempotencyKey,
    requestHash: row.requestHash,
    actorUserId: row.actorUserId,
    expectedTaskRevision: row.expectedTaskRevision,
    expectedGateRevision: row.expectedGateRevision,
    resultGateRevision: row.resultGateRevision,
    state: row.state,
    claimEpoch: row.claimEpoch,
    claimExpiresAt: row.claimExpiresAt,
    schemaVersion: row.schemaVersion,
    manifestJson: row.manifestJson,
    receiptJson: row.receiptJson,
    failureJson: row.failureJson,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    committedAt: row.committedAt,
    completedAt: row.completedAt,
  }
}

function assertJson(value: string, label: string): void {
  try {
    JSON.parse(value)
  } catch {
    throw new HumanGateOperationError(
      'human-gate-operation-manifest-invalid',
      `${label} must be valid JSON`,
    )
  }
}

async function operationById(tx: DatabaseTransaction, operationId: string): Promise<OperationRow> {
  const row = await tx
    .select()
    .from(collaborationGateOperations)
    .where(eq(collaborationGateOperations.id, operationId))
    .get()
  if (row === undefined) {
    throw new HumanGateOperationError(
      'human-gate-operation-not-found',
      `human-gate operation '${operationId}' does not exist`,
      { operationId },
    )
  }
  return row
}

function staleOperation(row: OperationRow, expectedClaimEpoch: number): never {
  throw new HumanGateOperationError(
    'human-gate-operation-stale',
    `human-gate operation '${row.id}' changed before mutation`,
    {
      operationId: row.id,
      expectedClaimEpoch,
      currentClaimEpoch: row.claimEpoch,
      currentState: row.state,
    },
  )
}

function assertRequest(input: BeginHumanGateOperationJournalInput): void {
  const { request } = input
  if (
    request.schemaVersion !== 1 ||
    request.taskId.length === 0 ||
    request.gateRef.length === 0 ||
    input.idempotencyKey.length === 0 ||
    !Number.isSafeInteger(request.expectedTaskRevision) ||
    request.expectedTaskRevision < 0 ||
    !Number.isSafeInteger(request.expectedGateRevision) ||
    request.expectedGateRevision < 0
  ) {
    throw new HumanGateOperationError(
      'human-gate-operation-manifest-invalid',
      'human-gate operation request identity and revisions must be valid',
    )
  }
}

async function existingIdempotency(
  tx: DatabaseTransaction,
  input: BeginHumanGateOperationJournalInput,
  requestHash: string,
): Promise<BegunHumanGateOperation | null> {
  const { request } = input
  const row = await tx
    .select()
    .from(collaborationGateOperations)
    .where(
      and(
        eq(collaborationGateOperations.taskId, request.taskId),
        eq(collaborationGateOperations.gateKind, request.gateKind),
        eq(collaborationGateOperations.operationKind, request.operationKind),
        eq(collaborationGateOperations.idempotencyKey, input.idempotencyKey),
      ),
    )
    .get()
  if (row === undefined) return null
  assertHumanGateIdempotencyMatch(row, {
    requestHash,
    actorUserId: request.actorUserId,
  })
  return { operation: snapshot(row), replayed: true }
}

async function activeOperation(
  tx: DatabaseTransaction,
  input: BeginHumanGateOperationJournalInput,
): Promise<OperationRow | undefined> {
  const { request } = input
  return await tx
    .select()
    .from(collaborationGateOperations)
    .where(
      and(
        eq(collaborationGateOperations.taskId, request.taskId),
        eq(collaborationGateOperations.gateKind, request.gateKind),
        eq(collaborationGateOperations.gateRef, request.gateRef),
        eq(collaborationGateOperations.operationKind, request.operationKind),
        inArray(collaborationGateOperations.state, ACTIVE_OPERATION_STATES),
      ),
    )
    .get()
}

function assertArtifactTransition(from: HumanGateArtifactState, to: HumanGateArtifactState): void {
  if (!(ARTIFACT_TRANSITIONS[from] as readonly HumanGateArtifactState[]).includes(to)) {
    throw new HumanGateOperationError(
      'human-gate-operation-transition-invalid',
      `human-gate artifact cannot transition from '${from}' to '${to}'`,
      { from, to },
    )
  }
}

async function artifactByKey(
  tx: DatabaseTransaction,
  operationId: string,
  artifactKey: string,
): Promise<ArtifactRow> {
  const row = await tx
    .select()
    .from(collaborationGateArtifacts)
    .where(
      and(
        eq(collaborationGateArtifacts.operationId, operationId),
        eq(collaborationGateArtifacts.artifactKey, artifactKey),
      ),
    )
    .get()
  if (row === undefined) {
    throw new HumanGateOperationError(
      'human-gate-operation-not-found',
      `human-gate artifact '${operationId}/${artifactKey}' does not exist`,
      { operationId, artifactKey },
    )
  }
  return row
}

function artifactSnapshot(row: ArtifactRow): HumanGateArtifactSnapshot {
  return {
    operationId: row.operationId,
    artifactKey: row.artifactKey,
    artifactKind: row.artifactKind,
    stagedPath: row.stagedPath,
    finalPath: row.finalPath,
    sha256: row.sha256,
    byteSize: row.byteSize,
    state: row.state,
    receiptJson: row.receiptJson,
    updatedAt: row.updatedAt,
  }
}

async function firstArtifactNotIn(
  tx: DatabaseTransaction,
  operationId: string,
  state: HumanGateArtifactState,
): Promise<string | undefined> {
  const row = await tx
    .select({ artifactKey: collaborationGateArtifacts.artifactKey })
    .from(collaborationGateArtifacts)
    .where(
      and(
        eq(collaborationGateArtifacts.operationId, operationId),
        ne(collaborationGateArtifacts.state, state),
      ),
    )
    .get()
  return row?.artifactKey
}

export class DatabaseHumanGateOperationJournal implements HumanGateOperationJournal {
  async beginTx(input: BeginHumanGateOperationJournalInput): Promise<BegunHumanGateOperation> {
    assertRequest(input)
    const { tx } = input
    await engineOf(tx).lockAggregateRoot(tx, tasks, tasks.id, input.request.taskId)
    const requestHash = canonicalHumanGateRequestHash(input.request)
    const replay = await existingIdempotency(tx, input, requestHash)
    if (replay !== null) return replay

    const winner = await activeOperation(tx, input)
    if (winner !== undefined) {
      throw new HumanGateOperationError(
        'human-gate-operation-conflict',
        `human-gate '${input.request.gateRef}' already has an active operation`,
        { winnerOperationId: winner.id },
      )
    }

    try {
      await tx
        .insert(collaborationGateOperations)
        .values({
          id: input.operationId,
          taskId: input.request.taskId,
          gateKind: input.request.gateKind,
          operationKind: input.request.operationKind,
          gateRef: input.request.gateRef,
          idempotencyKey: input.idempotencyKey,
          requestHash,
          actorUserId: input.request.actorUserId,
          expectedTaskRevision: input.request.expectedTaskRevision,
          expectedGateRevision: input.request.expectedGateRevision,
          resultGateRevision: null,
          state: 'preparing',
          claimEpoch: 1,
          claimExpiresAt: input.now + DEFAULT_HUMAN_GATE_CLAIM_LEASE_MS,
          schemaVersion: 1,
          manifestJson: canonicalHumanGateJson(input.request),
          receiptJson: null,
          failureJson: null,
          createdAt: input.now,
          updatedAt: input.now,
          committedAt: null,
          completedAt: null,
        })
        .run()
    } catch (error) {
      const racedReplay = await existingIdempotency(tx, input, requestHash)
      if (racedReplay !== null) return racedReplay
      const racedWinner = await activeOperation(tx, input)
      if (racedWinner !== undefined) {
        throw new HumanGateOperationError(
          'human-gate-operation-conflict',
          `human-gate '${input.request.gateRef}' already has an active operation`,
          { winnerOperationId: racedWinner.id },
        )
      }
      throw error
    }
    return { operation: snapshot(await operationById(tx, input.operationId)), replayed: false }
  }

  async findByIdempotencyTx(
    input: Parameters<HumanGateOperationJournal['findByIdempotencyTx']>[0],
  ): Promise<HumanGateOperationSnapshot | null> {
    const row = await input.tx
      .select()
      .from(collaborationGateOperations)
      .where(
        and(
          eq(collaborationGateOperations.taskId, input.taskId),
          eq(collaborationGateOperations.gateKind, input.gateKind),
          eq(collaborationGateOperations.operationKind, input.operationKind),
          eq(collaborationGateOperations.idempotencyKey, input.idempotencyKey),
        ),
      )
      .get()
    return row === undefined ? null : snapshot(row)
  }

  async latestGateRevisionTx(
    input: Parameters<HumanGateOperationJournal['latestGateRevisionTx']>[0],
  ): Promise<number> {
    const row = await input.tx
      .select({ revision: collaborationGateOperations.resultGateRevision })
      .from(collaborationGateOperations)
      .where(
        and(
          eq(collaborationGateOperations.gateKind, input.gateKind),
          eq(collaborationGateOperations.gateRef, input.gateRef),
          isNotNull(collaborationGateOperations.resultGateRevision),
        ),
      )
      .orderBy(desc(collaborationGateOperations.resultGateRevision))
      .limit(1)
      .get()
    return row?.revision ?? 0
  }

  async getTx(
    tx: DatabaseTransaction,
    operationId: string,
  ): Promise<HumanGateOperationSnapshot | null> {
    const row = await tx
      .select()
      .from(collaborationGateOperations)
      .where(eq(collaborationGateOperations.id, operationId))
      .get()
    return row === undefined ? null : snapshot(row)
  }

  async listArtifactsTx(
    tx: DatabaseTransaction,
    operationId: string,
  ): Promise<readonly HumanGateArtifactSnapshot[]> {
    const rows = await tx
      .select()
      .from(collaborationGateArtifacts)
      .where(eq(collaborationGateArtifacts.operationId, operationId))
      .orderBy(asc(collaborationGateArtifacts.artifactKey))
    return rows.map(artifactSnapshot)
  }

  async claimRecoveryBatchTx(input: {
    readonly tx: DatabaseTransaction
    readonly now: number
    readonly leaseMs: number
    readonly limit: number
  }): Promise<readonly HumanGateOperationSnapshot[]> {
    if (
      !Number.isSafeInteger(input.leaseMs) ||
      input.leaseMs <= 0 ||
      !Number.isSafeInteger(input.limit) ||
      input.limit <= 0
    ) {
      throw new HumanGateOperationError(
        'human-gate-operation-manifest-invalid',
        'human-gate recovery lease and batch limit must be positive integers',
      )
    }
    const { tx } = input
    const due = await tx
      .select()
      .from(collaborationGateOperations)
      .where(
        and(
          inArray(collaborationGateOperations.state, ACTIVE_OPERATION_STATES),
          // A prepared manual-question operation is an intentional durable wait for the
          // active task owner, not abandoned preparation. Its owner-settle participant, not
          // artifact recovery, consumes it.
          or(
            ne(collaborationGateOperations.operationKind, 'manual-question-open'),
            ne(collaborationGateOperations.state, 'prepared'),
          ),
          or(
            isNull(collaborationGateOperations.claimExpiresAt),
            lte(collaborationGateOperations.claimExpiresAt, input.now),
          ),
        ),
      )
      .orderBy(
        engineOf(tx).ascNullsFirst(collaborationGateOperations.claimExpiresAt),
        asc(collaborationGateOperations.updatedAt),
        asc(collaborationGateOperations.id),
      )
      .limit(input.limit)
    const claimed: HumanGateOperationSnapshot[] = []
    for (const row of due) {
      const result = await tx
        .update(collaborationGateOperations)
        .set({
          claimEpoch: row.claimEpoch + 1,
          claimExpiresAt: input.now + input.leaseMs,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(collaborationGateOperations.id, row.id),
            eq(collaborationGateOperations.state, row.state),
            eq(collaborationGateOperations.claimEpoch, row.claimEpoch),
            or(
              isNull(collaborationGateOperations.claimExpiresAt),
              lte(collaborationGateOperations.claimExpiresAt, input.now),
            ),
          ),
        )
        .run()
      if (affectedRows(result) === 1) claimed.push(snapshot(await operationById(tx, row.id)))
    }
    return claimed
  }

  async renewRecoveryClaimTx(input: {
    readonly tx: DatabaseTransaction
    readonly operationId: string
    readonly expectedClaimEpoch: number
    readonly now: number
    readonly leaseMs: number
  }): Promise<HumanGateOperationSnapshot> {
    const result = await input.tx
      .update(collaborationGateOperations)
      .set({ claimExpiresAt: input.now + input.leaseMs, updatedAt: input.now })
      .where(
        and(
          eq(collaborationGateOperations.id, input.operationId),
          inArray(collaborationGateOperations.state, ACTIVE_OPERATION_STATES),
          eq(collaborationGateOperations.claimEpoch, input.expectedClaimEpoch),
        ),
      )
      .run()
    if (affectedRows(result) !== 1) {
      staleOperation(await operationById(input.tx, input.operationId), input.expectedClaimEpoch)
    }
    return snapshot(await operationById(input.tx, input.operationId))
  }

  async markPreparedTx(input: {
    readonly tx: DatabaseTransaction
    readonly operationId: string
    readonly expectedClaimEpoch: number
    readonly manifestJson: string
    readonly now: number
  }): Promise<HumanGateOperationSnapshot> {
    assertHumanGateManifestJson(input.manifestJson)
    const row = await operationById(input.tx, input.operationId)
    assertHumanGateOperationTransition(row.state, 'prepared')
    const unstaged = await firstArtifactNotIn(input.tx, input.operationId, 'staged')
    if (unstaged !== undefined) {
      throw new HumanGateOperationError(
        'human-gate-operation-manifest-invalid',
        `human-gate artifact '${unstaged}' is not staged`,
        { operationId: input.operationId, artifactKey: unstaged },
      )
    }
    const result = await input.tx
      .update(collaborationGateOperations)
      .set({
        state: 'prepared',
        manifestJson: input.manifestJson,
        claimExpiresAt: input.now + DEFAULT_HUMAN_GATE_CLAIM_LEASE_MS,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(collaborationGateOperations.id, input.operationId),
          eq(collaborationGateOperations.state, 'preparing'),
          eq(collaborationGateOperations.claimEpoch, input.expectedClaimEpoch),
        ),
      )
      .run()
    if (affectedRows(result) !== 1) {
      staleOperation(await operationById(input.tx, input.operationId), input.expectedClaimEpoch)
    }
    return snapshot(await operationById(input.tx, input.operationId))
  }

  async commitTx(input: {
    readonly tx: DatabaseTransaction
    readonly operationId: string
    readonly expectedClaimEpoch: number
    readonly receiptJson: string
    readonly now: number
  }): Promise<HumanGateOperationSnapshot> {
    assertJson(input.receiptJson, 'human-gate operation receipt')
    const row = await operationById(input.tx, input.operationId)
    if (row.state === 'committed' || row.state === 'completed') {
      if (row.claimEpoch === input.expectedClaimEpoch && row.receiptJson === input.receiptJson) {
        return snapshot(row)
      }
      staleOperation(row, input.expectedClaimEpoch)
    }
    assertHumanGateOperationTransition(row.state, 'committed')
    const unready = await firstArtifactNotIn(input.tx, input.operationId, 'staged')
    if (unready !== undefined) {
      throw new HumanGateOperationError(
        'human-gate-operation-manifest-invalid',
        `human-gate artifact '${unready}' is not ready for commit`,
        { operationId: input.operationId, artifactKey: unready },
      )
    }
    const result = await input.tx
      .update(collaborationGateOperations)
      .set({
        state: 'committed',
        resultGateRevision: row.expectedGateRevision + 1,
        receiptJson: input.receiptJson,
        committedAt: input.now,
        claimExpiresAt: input.now + DEFAULT_HUMAN_GATE_CLAIM_LEASE_MS,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(collaborationGateOperations.id, input.operationId),
          inArray(collaborationGateOperations.state, ['preparing', 'prepared']),
          eq(collaborationGateOperations.claimEpoch, input.expectedClaimEpoch),
        ),
      )
      .run()
    if (affectedRows(result) !== 1) {
      staleOperation(await operationById(input.tx, input.operationId), input.expectedClaimEpoch)
    }
    await input.tx
      .update(collaborationGateArtifacts)
      .set({ state: 'consumed', updatedAt: input.now })
      .where(
        and(
          eq(collaborationGateArtifacts.operationId, input.operationId),
          eq(collaborationGateArtifacts.state, 'staged'),
        ),
      )
      .run()
    return snapshot(await operationById(input.tx, input.operationId))
  }

  async completeTx(input: {
    readonly tx: DatabaseTransaction
    readonly operationId: string
    readonly expectedClaimEpoch: number
    readonly now: number
  }): Promise<HumanGateOperationSnapshot> {
    const row = await operationById(input.tx, input.operationId)
    if (row.state === 'completed' && row.claimEpoch === input.expectedClaimEpoch) {
      return snapshot(row)
    }
    if (row.state !== 'committed') {
      throw new HumanGateOperationError(
        'human-gate-operation-transition-invalid',
        `human-gate operation '${input.operationId}' is not committed`,
        { operationId: input.operationId, currentState: row.state },
      )
    }
    assertHumanGateOperationTransition(row.state, 'completed')
    const unfinished = await firstArtifactNotIn(input.tx, input.operationId, 'finalized')
    if (unfinished !== undefined) {
      throw new HumanGateOperationError(
        'human-gate-operation-transition-invalid',
        `human-gate artifact '${unfinished}' is not finalized`,
        { operationId: input.operationId, artifactKey: unfinished },
      )
    }
    const result = await input.tx
      .update(collaborationGateOperations)
      .set({
        state: 'completed',
        claimExpiresAt: null,
        completedAt: input.now,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(collaborationGateOperations.id, input.operationId),
          eq(collaborationGateOperations.state, 'committed'),
          eq(collaborationGateOperations.claimEpoch, input.expectedClaimEpoch),
        ),
      )
      .run()
    if (affectedRows(result) !== 1) {
      staleOperation(await operationById(input.tx, input.operationId), input.expectedClaimEpoch)
    }
    return snapshot(await operationById(input.tx, input.operationId))
  }

  async markCleanupPendingTx(input: {
    readonly tx: DatabaseTransaction
    readonly operationId: string
    readonly expectedClaimEpoch: number
    readonly now: number
  }): Promise<HumanGateOperationSnapshot> {
    const row = await operationById(input.tx, input.operationId)
    if (row.state !== 'preparing' && row.state !== 'prepared') {
      throw new HumanGateOperationError(
        'human-gate-operation-transition-invalid',
        `human-gate operation '${input.operationId}' cannot enter cleanup from '${row.state}'`,
        { operationId: input.operationId, currentState: row.state },
      )
    }
    assertHumanGateOperationTransition(row.state, 'cleanup_pending')
    const result = await input.tx
      .update(collaborationGateOperations)
      .set({ state: 'cleanup_pending', updatedAt: input.now })
      .where(
        and(
          eq(collaborationGateOperations.id, input.operationId),
          eq(collaborationGateOperations.state, row.state),
          eq(collaborationGateOperations.claimEpoch, input.expectedClaimEpoch),
        ),
      )
      .run()
    if (affectedRows(result) !== 1) {
      staleOperation(await operationById(input.tx, input.operationId), input.expectedClaimEpoch)
    }
    await input.tx
      .update(collaborationGateArtifacts)
      .set({ state: 'cleanup_pending', updatedAt: input.now })
      .where(
        and(
          eq(collaborationGateArtifacts.operationId, input.operationId),
          inArray(collaborationGateArtifacts.state, ['declared', 'staged']),
        ),
      )
      .run()
    return snapshot(await operationById(input.tx, input.operationId))
  }

  async deleteCleanupArtifactsTx(input: {
    readonly tx: DatabaseTransaction
    readonly operationId: string
    readonly expectedClaimEpoch: number
  }): Promise<void> {
    const operation = await operationById(input.tx, input.operationId)
    if (
      operation.state !== 'cleanup_pending' ||
      operation.claimEpoch !== input.expectedClaimEpoch
    ) {
      staleOperation(operation, input.expectedClaimEpoch)
    }
    const unexpected = await firstArtifactNotIn(input.tx, input.operationId, 'cleanup_pending')
    if (unexpected !== undefined) {
      throw new HumanGateOperationError(
        'human-gate-operation-transition-invalid',
        `human-gate artifact '${unexpected}' is not cleanup-pending`,
        { operationId: input.operationId, artifactKey: unexpected },
      )
    }
    await input.tx
      .delete(collaborationGateArtifacts)
      .where(eq(collaborationGateArtifacts.operationId, input.operationId))
      .run()
  }

  async completeCleanupTx(input: {
    readonly tx: DatabaseTransaction
    readonly operationId: string
    readonly expectedClaimEpoch: number
    readonly failureJson: string
    readonly now: number
  }): Promise<HumanGateOperationSnapshot> {
    assertJson(input.failureJson, 'human-gate cleanup result')
    const row = await operationById(input.tx, input.operationId)
    if (row.state !== 'cleanup_pending') {
      throw new HumanGateOperationError(
        'human-gate-operation-transition-invalid',
        `human-gate operation '${input.operationId}' is not cleanup-pending`,
        { operationId: input.operationId, currentState: row.state },
      )
    }
    const remaining = await input.tx
      .select({ artifactKey: collaborationGateArtifacts.artifactKey })
      .from(collaborationGateArtifacts)
      .where(eq(collaborationGateArtifacts.operationId, input.operationId))
      .get()
    if (remaining !== undefined) {
      throw new HumanGateOperationError(
        'human-gate-operation-transition-invalid',
        `human-gate artifact '${remaining.artifactKey}' has not been cleaned`,
        { operationId: input.operationId, artifactKey: remaining.artifactKey },
      )
    }
    const result = await input.tx
      .update(collaborationGateOperations)
      .set({
        state: 'completed',
        failureJson: input.failureJson,
        claimExpiresAt: null,
        completedAt: input.now,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(collaborationGateOperations.id, input.operationId),
          eq(collaborationGateOperations.state, 'cleanup_pending'),
          eq(collaborationGateOperations.claimEpoch, input.expectedClaimEpoch),
        ),
      )
      .run()
    if (affectedRows(result) !== 1) {
      staleOperation(await operationById(input.tx, input.operationId), input.expectedClaimEpoch)
    }
    return snapshot(await operationById(input.tx, input.operationId))
  }

  async declareArtifactsTx(
    input: Parameters<HumanGateOperationJournal['declareArtifactsTx']>[0],
  ): Promise<void> {
    const operation = await operationById(input.tx, input.operationId)
    if (operation.state !== 'preparing') staleOperation(operation, operation.claimEpoch)
    const seen = new Set<string>()
    for (const artifact of input.artifacts) {
      if (
        artifact.artifactKey.length === 0 ||
        artifact.stagedPath.length === 0 ||
        artifact.finalPath.length === 0 ||
        artifact.sha256.length === 0 ||
        !Number.isSafeInteger(artifact.byteSize) ||
        artifact.byteSize < 0 ||
        seen.has(artifact.artifactKey)
      ) {
        throw new HumanGateOperationError(
          'human-gate-operation-manifest-invalid',
          'human-gate artifact declaration is invalid',
          { operationId: input.operationId, artifactKey: artifact.artifactKey },
        )
      }
      seen.add(artifact.artifactKey)
    }
    for (const artifact of input.artifacts) {
      await input.tx
        .insert(collaborationGateArtifacts)
        .values({
          operationId: input.operationId,
          artifactKey: artifact.artifactKey,
          artifactKind: 'review-doc',
          stagedPath: artifact.stagedPath,
          finalPath: artifact.finalPath,
          sha256: artifact.sha256,
          byteSize: artifact.byteSize,
          state: 'declared',
          receiptJson: null,
          updatedAt: input.now,
        })
        .run()
    }
  }

  async transitionArtifactTx(
    input: Parameters<HumanGateOperationJournal['transitionArtifactTx']>[0],
  ): Promise<void> {
    if (input.expectedClaimEpoch !== undefined) {
      const operation = await operationById(input.tx, input.operationId)
      if (operation.claimEpoch !== input.expectedClaimEpoch) {
        staleOperation(operation, input.expectedClaimEpoch)
      }
    }
    if (input.receiptJson !== undefined && input.receiptJson !== null) {
      assertJson(input.receiptJson, 'human-gate artifact receipt')
    }
    const row = await artifactByKey(input.tx, input.operationId, input.artifactKey)
    if (row.state === input.to) {
      if (input.receiptJson === undefined || row.receiptJson === input.receiptJson) return
      throw new HumanGateOperationError(
        'human-gate-idempotency-conflict',
        `human-gate artifact '${input.artifactKey}' receipt changed during replay`,
        { operationId: input.operationId, artifactKey: input.artifactKey },
      )
    }
    if (row.state !== input.from) {
      throw new HumanGateOperationError(
        'human-gate-operation-stale',
        `human-gate artifact '${input.artifactKey}' changed before mutation`,
        { operationId: input.operationId, artifactKey: input.artifactKey },
      )
    }
    assertArtifactTransition(row.state, input.to)
    if (
      (input.to === 'staged' || input.to === 'finalized') &&
      (input.receiptJson === undefined || input.receiptJson === null)
    ) {
      throw new HumanGateOperationError(
        'human-gate-operation-manifest-invalid',
        `human-gate artifact '${input.artifactKey}' requires a transition receipt`,
        { operationId: input.operationId, artifactKey: input.artifactKey },
      )
    }
    const result = await input.tx
      .update(collaborationGateArtifacts)
      .set({
        state: input.to,
        receiptJson: input.receiptJson === undefined ? row.receiptJson : input.receiptJson,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(collaborationGateArtifacts.operationId, input.operationId),
          eq(collaborationGateArtifacts.artifactKey, input.artifactKey),
          eq(collaborationGateArtifacts.state, input.from),
        ),
      )
      .run()
    if (affectedRows(result) !== 1) {
      throw new HumanGateOperationError(
        'human-gate-operation-stale',
        `human-gate artifact '${input.artifactKey}' changed before mutation`,
        { operationId: input.operationId, artifactKey: input.artifactKey },
      )
    }
  }
}
