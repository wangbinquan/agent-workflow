import { canonicalSchemaJson } from '@/platform/persistence/schema/canonical'
import { createContentPublicationLedger } from '@/platform/content/infrastructure/contentStore'
import type {
  HistoryRestrictionPort,
  HistoryRestrictionGate,
} from '@/platform/contracts/historyRestriction'
import {
  canonicalHumanGateValueJson,
  type CanonicalHumanGateRequest,
  canonicalHumanGateJson,
  canonicalHumanGateRequestHash,
} from '../domain/canonicalGateRequest'
import { contentRefColumns, type ContentStore } from '@/platform/content/contentStore'
import type { ContentRef } from '@/platform/content/contentRef'
import type { HumanGateArtifactStore } from '../application/ports/humanGateArtifactStore'
import { sha256Hex } from '@/util/hash'
import { createLogger } from '@/util/log'
import type { HumanGateTaskLockPort } from '../composition/required-ports'
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

import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf, type PersistenceTables } from '@/platform/persistence/sessionTables'
import { first, queryWrite } from '@/platform/persistence/queryHelpers'
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lte, ne, or } from 'drizzle-orm'

import { insertInBatches } from '@/platform/persistence/batchInsert'
import {
  affectedRows,
  engineOf,
  databaseSessionFor,
} from '@/platform/persistence/databaseTransaction'
import type { PersistenceDb, PersistenceTx } from '@/platform/persistence/persistenceDb'

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

type OperationRow = PersistenceTables['collaborationGateOperations']['$inferSelect']
type ArtifactRow = PersistenceTables['collaborationGateArtifacts']['$inferSelect']

const ACTIVE_OPERATION_STATES = ['preparing', 'prepared', 'committed', 'cleanup_pending'] as const
const log = createLogger('human-gate-operations')

const ARTIFACT_TRANSITIONS = {
  declared: ['staged', 'cleanup_pending'],
  staged: ['consumed', 'cleanup_pending'],
  consumed: ['finalized', 'cleanup_pending'],
  finalized: [],
  cleanup_pending: [],
} as const satisfies Record<HumanGateArtifactState, readonly HumanGateArtifactState[]>

export interface BeginHumanGateOperationJournalInput {
  readonly tx: PersistenceTx
  readonly operationId: string
  readonly request: CanonicalHumanGateRequest
  readonly idempotencyKey: string
  readonly now: number
}

/** 事务内的 human-gate 操作日志。方法名沿用 `*Tx` 后缀：它们跑在调用方的事务里，不自开事务。 */
export interface HumanGateOperationJournal {
  beginTx(input: BeginHumanGateOperationJournalInput): Promise<BegunHumanGateOperation>
  findByIdempotencyTx(input: {
    readonly tx: PersistenceTx
    readonly taskId: string
    readonly gateKind: CanonicalHumanGateRequest['gateKind']
    readonly operationKind: CanonicalHumanGateRequest['operationKind']
    readonly idempotencyKey: string
  }): Promise<HumanGateOperationSnapshot | null>
  latestGateRevisionTx(input: {
    readonly tx: PersistenceTx
    readonly gateKind: CanonicalHumanGateRequest['gateKind']
    readonly gateRef: string
  }): Promise<number>
  getTx(tx: PersistenceTx, operationId: string): Promise<HumanGateOperationSnapshot | null>
  listArtifactsTx(
    tx: PersistenceTx,
    operationId: string,
  ): Promise<readonly HumanGateArtifactSnapshot[]>
  claimRecoveryBatchTx(input: {
    readonly tx: PersistenceTx
    readonly now: number
    readonly leaseMs: number
    readonly limit: number
  }): Promise<readonly HumanGateOperationSnapshot[]>
  renewRecoveryClaimTx(input: {
    readonly tx: PersistenceTx
    readonly operationId: string
    readonly expectedClaimEpoch: number
    readonly now: number
    readonly leaseMs: number
  }): Promise<HumanGateOperationSnapshot>
  markPreparedTx(input: {
    readonly tx: PersistenceTx
    readonly operationId: string
    readonly expectedClaimEpoch: number
    readonly manifestJson: string
    readonly now: number
  }): Promise<HumanGateOperationSnapshot>
  commitTx(input: {
    readonly tx: PersistenceTx
    readonly operationId: string
    readonly expectedClaimEpoch: number
    readonly receiptJson: string
    readonly now: number
  }): Promise<HumanGateOperationSnapshot>
  completeTx(input: {
    readonly tx: PersistenceTx
    readonly operationId: string
    readonly expectedClaimEpoch: number
    readonly now: number
  }): Promise<HumanGateOperationSnapshot>
  markCleanupPendingTx(input: {
    readonly tx: PersistenceTx
    readonly operationId: string
    readonly expectedClaimEpoch: number
    readonly now: number
  }): Promise<HumanGateOperationSnapshot>
  deleteCleanupArtifactsTx(input: {
    readonly tx: PersistenceTx
    readonly operationId: string
    readonly expectedClaimEpoch: number
  }): Promise<void>
  completeCleanupTx(input: {
    readonly tx: PersistenceTx
    readonly operationId: string
    readonly expectedClaimEpoch: number
    readonly failureJson: string
    readonly now: number
  }): Promise<HumanGateOperationSnapshot>
  declareArtifactsTx(input: {
    readonly tx: PersistenceTx
    readonly operationId: string
    readonly artifacts: readonly HumanGateArtifactDeclaration[]
    readonly now: number
  }): Promise<void>
  transitionArtifactTx(input: {
    readonly tx: PersistenceTx
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

async function operationById(tx: PersistenceTx, operationId: string): Promise<OperationRow> {
  const { collaborationGateOperations } = tablesOf(tx)
  const row = await first(
    tx
      .select()
      .from(collaborationGateOperations)
      .where(eq(collaborationGateOperations.id, operationId)),
  )
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
  tx: PersistenceTx,
  input: BeginHumanGateOperationJournalInput,
  requestHash: string,
): Promise<BegunHumanGateOperation | null> {
  const { request } = input
  const { collaborationGateOperations } = tablesOf(tx)
  const row = await first(
    tx
      .select()
      .from(collaborationGateOperations)
      .where(
        and(
          eq(collaborationGateOperations.taskId, request.taskId),
          eq(collaborationGateOperations.gateKind, request.gateKind),
          eq(collaborationGateOperations.operationKind, request.operationKind),
          eq(collaborationGateOperations.idempotencyKey, input.idempotencyKey),
        ),
      ),
  )
  if (row === undefined) return null
  assertHumanGateIdempotencyMatch(row, {
    requestHash,
    actorUserId: request.actorUserId,
  })
  return { operation: snapshot(row), replayed: true }
}

async function activeOperation(
  tx: PersistenceTx,
  input: BeginHumanGateOperationJournalInput,
): Promise<OperationRow | undefined> {
  const { request } = input
  const { collaborationGateOperations } = tablesOf(tx)
  return await first(
    tx
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
      ),
  )
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
  tx: PersistenceTx,
  operationId: string,
  artifactKey: string,
): Promise<ArtifactRow> {
  const { collaborationGateArtifacts } = tablesOf(tx)
  const row = await first(
    tx
      .select()
      .from(collaborationGateArtifacts)
      .where(
        and(
          eq(collaborationGateArtifacts.operationId, operationId),
          eq(collaborationGateArtifacts.artifactKey, artifactKey),
        ),
      ),
  )
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
    stagedPath: `gate-stage:${row.operationId}:${row.artifactKey}`,
    finalPath: row.finalContentKey,
    sha256: row.sha256,
    byteSize: row.byteSize,
    state: row.state,
    receiptJson: row.receiptJson,
    updatedAt: row.updatedAt,
  }
}

async function firstArtifactNotIn(
  tx: PersistenceTx,
  operationId: string,
  state: HumanGateArtifactState,
): Promise<string | undefined> {
  const { collaborationGateArtifacts } = tablesOf(tx)
  const row = await first(
    tx
      .select({ artifactKey: collaborationGateArtifacts.artifactKey })
      .from(collaborationGateArtifacts)
      .where(
        and(
          eq(collaborationGateArtifacts.operationId, operationId),
          ne(collaborationGateArtifacts.state, state),
        ),
      ),
  )
  return row?.artifactKey
}

export class DatabaseHumanGateOperationJournal implements HumanGateOperationJournal {
  // RFC-294 S5 后改用 task-execution offered participant createHumanGatePersistenceParticipantInTx(tx).lockTask。
  constructor(
    private readonly taskLock: HumanGateTaskLockPort,
    private readonly historyRestrictions: HistoryRestrictionPort,
  ) {}

  async beginTx(input: BeginHumanGateOperationJournalInput): Promise<BegunHumanGateOperation> {
    assertRequest(input)
    const { tx } = input
    await this.taskLock(tx).lockTask(input.request.taskId)
    const requestHash = canonicalHumanGateRequestHash(input.request)
    const replay = await existingIdempotency(tx, input, requestHash)
    if (replay !== null) {
      await assertGateReplayAllowed(tx, this.historyRestrictions, replay.operation)
      return replay
    }

    const winner = await activeOperation(tx, input)
    if (winner !== undefined) {
      throw new HumanGateOperationError(
        'human-gate-operation-conflict',
        `human-gate '${input.request.gateRef}' already has an active operation`,
        { winnerOperationId: winner.id },
      )
    }

    try {
      const { collaborationGateOperations } = tablesOf(tx)
      await insertOne(tx, collaborationGateOperations, {
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
        schemaVersion:
          input.request.operationKind === 'open' && input.request.gateKind !== 'questions' ? 2 : 1,
        manifestJson: canonicalHumanGateJson(input.request),
        receiptJson: null,
        failureJson: null,
        createdAt: input.now,
        updatedAt: input.now,
        committedAt: null,
        completedAt: null,
      })
    } catch (error) {
      const racedReplay = await existingIdempotency(tx, input, requestHash)
      if (racedReplay !== null) {
        await assertGateReplayAllowed(tx, this.historyRestrictions, racedReplay.operation)
        return racedReplay
      }
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
    const { collaborationGateOperations } = tablesOf(input.tx)
    const row = await first(
      input.tx
        .select()
        .from(collaborationGateOperations)
        .where(
          and(
            eq(collaborationGateOperations.taskId, input.taskId),
            eq(collaborationGateOperations.gateKind, input.gateKind),
            eq(collaborationGateOperations.operationKind, input.operationKind),
            eq(collaborationGateOperations.idempotencyKey, input.idempotencyKey),
          ),
        ),
    )
    if (row) await assertGateReplayAllowed(input.tx, this.historyRestrictions, snapshot(row))
    return row === undefined ? null : snapshot(row)
  }

  async latestGateRevisionTx(
    input: Parameters<HumanGateOperationJournal['latestGateRevisionTx']>[0],
  ): Promise<number> {
    const { collaborationGateOperations } = tablesOf(input.tx)
    const row = await first(
      input.tx
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
        .limit(1),
    )
    return row?.revision ?? 0
  }

  async getTx(tx: PersistenceTx, operationId: string): Promise<HumanGateOperationSnapshot | null> {
    const { collaborationGateOperations } = tablesOf(tx)
    const row = await first(
      tx
        .select()
        .from(collaborationGateOperations)
        .where(eq(collaborationGateOperations.id, operationId)),
    )
    return row === undefined ? null : snapshot(row)
  }

  async listArtifactsTx(
    tx: PersistenceTx,
    operationId: string,
  ): Promise<readonly HumanGateArtifactSnapshot[]> {
    const { collaborationGateArtifacts } = tablesOf(tx)
    const rows = await tx
      .select()
      .from(collaborationGateArtifacts)
      .where(eq(collaborationGateArtifacts.operationId, operationId))
      .orderBy(asc(collaborationGateArtifacts.artifactKey))
    return rows.map(artifactSnapshot)
  }

  async claimRecoveryBatchTx(input: {
    readonly tx: PersistenceTx
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
    const { collaborationGateOperations } = tablesOf(tx)
    const claimed: HumanGateOperationSnapshot[] = []
    let after: OperationRow | undefined
    while (claimed.length < input.limit) {
      // Advance past restricted rows without changing their lease or letting a full
      // restricted page starve admitted operations. The cursor uses the pre-claim facts.
      const afterTime =
        after &&
        or(
          gt(collaborationGateOperations.updatedAt, after.updatedAt),
          and(
            eq(collaborationGateOperations.updatedAt, after.updatedAt),
            gt(collaborationGateOperations.id, after.id),
          ),
        )
      const cursor =
        after === undefined
          ? undefined
          : after.claimExpiresAt === null
            ? or(
                isNotNull(collaborationGateOperations.claimExpiresAt),
                and(isNull(collaborationGateOperations.claimExpiresAt), afterTime),
              )
            : or(
                gt(collaborationGateOperations.claimExpiresAt, after.claimExpiresAt),
                and(
                  eq(collaborationGateOperations.claimExpiresAt, after.claimExpiresAt),
                  afterTime,
                ),
              )
      const due: OperationRow[] = await tx
        .select()
        .from(collaborationGateOperations)
        .where(
          and(
            cursor,
            inArray(collaborationGateOperations.state, ACTIVE_OPERATION_STATES),
            or(
              ne(collaborationGateOperations.operationKind, 'open'),
              eq(collaborationGateOperations.gateKind, 'questions'),
              eq(collaborationGateOperations.schemaVersion, 2),
              inArray(collaborationGateOperations.state, ['committed', 'cleanup_pending']),
            ),
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
      if (due.length === 0) break
      after = due[due.length - 1]!
      for (const row of due) {
        try {
          await assertGateReplayAllowed(tx, this.historyRestrictions, snapshot(row))
        } catch (error) {
          if (!(error instanceof HumanGateOperationError) || error.code !== 'history-only')
            throw error
          log.info('history-only gate skipped during recovery', {
            operationId: row.id,
            taskId: row.taskId,
            code: error.code,
          })
          continue
        }
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
        if (affectedRows(result) === 1) claimed.push(snapshot(await operationById(tx, row.id)))
        if (claimed.length === input.limit) break
      }
    }
    return claimed
  }

  async renewRecoveryClaimTx(input: {
    readonly tx: PersistenceTx
    readonly operationId: string
    readonly expectedClaimEpoch: number
    readonly now: number
    readonly leaseMs: number
  }): Promise<HumanGateOperationSnapshot> {
    const { collaborationGateOperations } = tablesOf(input.tx)
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
    if (affectedRows(result) !== 1) {
      staleOperation(await operationById(input.tx, input.operationId), input.expectedClaimEpoch)
    }
    return snapshot(await operationById(input.tx, input.operationId))
  }

  async markPreparedTx(input: {
    readonly tx: PersistenceTx
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
    const { collaborationGateOperations } = tablesOf(input.tx)
    const result = await input.tx
      .update(collaborationGateOperations)
      .set({
        state: 'prepared',
        schemaVersion: JSON.parse(input.manifestJson).schemaVersion as number,
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
    if (affectedRows(result) !== 1) {
      staleOperation(await operationById(input.tx, input.operationId), input.expectedClaimEpoch)
    }
    return snapshot(await operationById(input.tx, input.operationId))
  }

  async commitTx(input: {
    readonly tx: PersistenceTx
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
    const { collaborationGateOperations } = tablesOf(input.tx)
    const { collaborationGateArtifacts } = tablesOf(input.tx)
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
    return snapshot(await operationById(input.tx, input.operationId))
  }

  async completeTx(input: {
    readonly tx: PersistenceTx
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
    const { collaborationGateOperations } = tablesOf(input.tx)
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
    if (affectedRows(result) !== 1) {
      staleOperation(await operationById(input.tx, input.operationId), input.expectedClaimEpoch)
    }
    return snapshot(await operationById(input.tx, input.operationId))
  }

  async markCleanupPendingTx(input: {
    readonly tx: PersistenceTx
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
    const { collaborationGateOperations } = tablesOf(input.tx)
    const { collaborationGateArtifacts } = tablesOf(input.tx)
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
    return snapshot(await operationById(input.tx, input.operationId))
  }

  async deleteCleanupArtifactsTx(input: {
    readonly tx: PersistenceTx
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
    const { collaborationGateArtifacts } = tablesOf(input.tx)
    await input.tx
      .delete(collaborationGateArtifacts)
      .where(eq(collaborationGateArtifacts.operationId, input.operationId))
  }

  async completeCleanupTx(input: {
    readonly tx: PersistenceTx
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
    const { collaborationGateOperations } = tablesOf(input.tx)
    const { collaborationGateArtifacts } = tablesOf(input.tx)
    const remaining = await first(
      input.tx
        .select({ artifactKey: collaborationGateArtifacts.artifactKey })
        .from(collaborationGateArtifacts)
        .where(eq(collaborationGateArtifacts.operationId, input.operationId)),
    )
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
    const { collaborationGateArtifacts } = tablesOf(input.tx)
    // RFC-359 W6-T25 —— 产物声明按批落库。它的条数与 review-open 的 `manifest.documents` **相等**
    // （两者由同一份文档集派生，`humanGateOpenParticipant` 显式断言长度一致），所以一次 review-open
    // 此前要付 2N 条逐行 INSERT。批内重复的 artifactKey 由上面那轮 `seen` 校验挡住（重复即抛），
    // 这里不需要再按键压平——压平反而会把那条校验吃掉。
    await insertInBatches(
      input.tx,
      collaborationGateArtifacts,
      input.artifacts.map((artifact) => ({
        operationId: input.operationId,
        artifactKey: artifact.artifactKey,
        artifactKind: 'review-doc' as const,
        stagedContentRefJson: null,
        stagedInlineBytes: null,
        finalContentKey: artifact.finalPath,
        contentRefJson: null,
        contentInlineBytes: null,
        sha256: artifact.sha256,
        byteSize: artifact.byteSize,
        state: 'declared' as const,
        receiptJson: null,
        updatedAt: input.now,
      })),
      (batch) => {
        return queryWrite(input.tx.insert(collaborationGateArtifacts).values([...batch]))
      },
    )
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
    if (input.to === 'staged' || input.to === 'consumed' || input.to === 'finalized')
      artifactContent(row)
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
    const { collaborationGateArtifacts } = tablesOf(input.tx)
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
    if (affectedRows(result) !== 1) {
      throw new HumanGateOperationError(
        'human-gate-operation-stale',
        `human-gate artifact '${input.artifactKey}' changed before mutation`,
        { operationId: input.operationId, artifactKey: input.artifactKey },
      )
    }
  }
}

/** Restriction keys use the frozen mk1 wire form; no source reader is loaded by the daemon. */
export async function assertGateReplayAllowed(
  tx: PersistenceTx,
  restrictions: HistoryRestrictionPort,
  operation: HumanGateOperationSnapshot,
): Promise<void> {
  if (!restrictions) throw new Error('gate-history-restriction-provider-required')
  const manifest = JSON.parse(operation.manifestJson) as {
    node?: { id?: string; consumedUpstreamRunsJson?: string }
    sourceNodeRunIds?: readonly string[]
    rerunNodeRunIds?: readonly string[]
    payload?: { roundId?: string }
    request?: { payload?: { roundId?: string } }
    round?: { id?: string; askingNodeRunId?: string; intermediaryNodeRunId?: string }
  }
  const gate = (
    sourceTable: HistoryRestrictionGate['sourceTable'],
    id: string,
  ): HistoryRestrictionGate => ({
    sourceTable,
    sourceKey: `mk1:${canonicalSchemaJson([sourceTable, [{ type: 'text', value: id }]])}`,
  })
  const roundId =
    manifest.round?.id ?? manifest.payload?.roundId ?? manifest.request?.payload?.roundId
  const nodeRunIds = new Set<string>()
  for (const id of [
    manifest.node?.id,
    manifest.round?.askingNodeRunId,
    manifest.round?.intermediaryNodeRunId,
    ...(manifest.sourceNodeRunIds ?? []),
    ...(manifest.rerunNodeRunIds ?? []),
  ])
    if (id) nodeRunIds.add(id)
  if (manifest.node?.consumedUpstreamRunsJson) {
    const consumed = JSON.parse(manifest.node.consumedUpstreamRunsJson) as Record<
      string,
      string | string[]
    >
    for (const ids of Object.values(consumed))
      for (const id of typeof ids === 'string' ? [ids] : ids) nodeRunIds.add(id)
  }
  const decision = await restrictions.check(tx, {
    taskId: operation.taskId,
    action: 'replay',
    nodeRunIds: [...nodeRunIds],
    gates: [
      gate('collaboration_gate_operations', operation.id),
      ...(roundId ? [gate('clarify_rounds', roundId)] : []),
    ],
  })
  if (!decision.allowed)
    throw new HumanGateOperationError(
      'history-only',
      'This gate is retained for history and cannot be replayed.',
      { operationId: operation.id },
    )
}

function artifactContent(row: ArtifactRow): ContentRef {
  const ref = contentRefColumns.decode(row.contentRefJson, row.contentInlineBytes)
  if (!ref)
    throw new HumanGateOperationError(
      'human-gate-artifact-missing',
      'Gate artifact has no published content.',
    )
  if (ref.sha256 !== row.sha256 || ref.size !== row.byteSize)
    throw new HumanGateOperationError(
      'human-gate-artifact-digest-mismatch',
      'Gate content metadata changed.',
    )
  return ref
}

function missingContent(error: unknown): boolean {
  return (
    (error instanceof HumanGateOperationError && error.code === 'human-gate-artifact-missing') ||
    (error instanceof Error &&
      (('code' in error && error.code === 'ENOENT') ||
        ['content-object-missing', 'content-bytes-missing'].includes(error.message)))
  )
}

/** Converted committed v1 opens may still have bytes only at the staged reference. */
export async function readHumanGateArtifactContent(
  content: Pick<ContentStore, 'read'>,
  row: ArtifactRow,
): Promise<Uint8Array> {
  let bytes: Uint8Array
  try {
    bytes = await content.read(artifactContent(row))
  } catch (error) {
    if (!missingContent(error) || row.stagedContentRefJson === null) throw error
    bytes = await content.read(
      artifactContent({
        ...row,
        contentRefJson: row.stagedContentRefJson,
        contentInlineBytes: row.stagedInlineBytes,
      }),
    )
  }
  if (sha256Hex(bytes) !== row.sha256 || bytes.byteLength !== row.byteSize)
    throw new HumanGateOperationError(
      'human-gate-artifact-digest-mismatch',
      'Published review bytes changed.',
    )
  return bytes
}

/** History reads use the same staged fallback as recovery, without changing stored refs. */
export async function readCommittedReviewDocumentContent(
  db: PersistenceDb,
  content: Pick<ContentStore, 'read'>,
  row: { contentRefJson: string; contentInlineBytes: Uint8Array | null },
): Promise<Uint8Array> {
  const ref = contentRefColumns.decode(row.contentRefJson, row.contentInlineBytes)
  if (ref === null)
    throw new HumanGateOperationError('human-gate-artifact-missing', 'Review content is missing.')
  try {
    return await content.read(ref)
  } catch (error) {
    if (!missingContent(error)) throw error
    const legacyKey =
      ref.kind !== 'inline' &&
      ['review-body', 'review-body-path'].includes(ref.location.codec) &&
      typeof ref.location.value === 'string'
        ? ref.location.value
        : undefined
    const { collaborationGateArtifacts } = tablesOf(db)
    const { collaborationGateOperations } = tablesOf(db)
    const artifact = await first(
      db
        .select({ artifact: collaborationGateArtifacts })
        .from(collaborationGateArtifacts)
        .innerJoin(
          collaborationGateOperations,
          eq(collaborationGateOperations.id, collaborationGateArtifacts.operationId),
        )
        .where(
          and(
            or(
              eq(collaborationGateArtifacts.contentRefJson, row.contentRefJson),
              legacyKey === undefined
                ? undefined
                : eq(collaborationGateArtifacts.finalContentKey, legacyKey),
            ),
            inArray(collaborationGateArtifacts.state, ['consumed', 'finalized']),
            inArray(collaborationGateOperations.state, ['committed', 'completed']),
          ),
        ),
    )
    if (!artifact) throw error
    return readHumanGateArtifactContent(content, artifact.artifact)
  }
}

/** A injects X's profile-selected store into the existing preparation/recovery port. */
export function createContentHumanGateArtifactStore(input: {
  readonly content: ContentStore
  readonly db: PersistenceDb
}): HumanGateArtifactStore {
  const load = async (artifact: HumanGateArtifactSnapshot) => {
    const row = await artifactByKey(input.db, artifact.operationId, artifact.artifactKey)
    if (
      row.finalContentKey !== artifact.finalPath ||
      row.sha256 !== artifact.sha256 ||
      row.byteSize !== artifact.byteSize
    )
      throw new HumanGateOperationError(
        'human-gate-artifact-digest-mismatch',
        'Gate artifact identity changed.',
      )
    return row
  }
  return {
    planReviewArtifact(plan) {
      const bytes = new TextEncoder().encode(plan.body)
      return {
        operationId: plan.operationId,
        artifactKey: plan.artifactKey,
        stagedPath: `gate-stage:${plan.operationId}:${plan.artifactKey}`,
        finalPath: plan.finalPath,
        sha256: sha256Hex(bytes),
        byteSize: bytes.byteLength,
      }
    },
    async stageReviewArtifact(plan, body) {
      const bytes = new TextEncoder().encode(body)
      if (sha256Hex(bytes) !== plan.sha256 || bytes.byteLength !== plan.byteSize)
        throw new HumanGateOperationError(
          'human-gate-artifact-digest-mismatch',
          'Review body changed after planning.',
        )
      const now = Date.now()
      const operation = await operationById(input.db, plan.operationId)
      await input.content.put(
        {
          publication: {
            owner: 'collaboration-review',
            logicalKey: plan.finalPath,
            attempt: plan.operationId,
            epoch: 1,
            scope: operation.taskId,
            sha256: plan.sha256,
            size: plan.byteSize,
          },
          source: { kind: 'bytes', bytes },
          contentVersion: 1,
          mediaType: 'text/markdown',
          references: 'shared',
        },
        async (tx, ref) => {
          const { collaborationGateArtifacts } = tablesOf(tx)
          const row = await artifactByKey(tx, plan.operationId, plan.artifactKey)
          if (
            row.finalContentKey !== plan.finalPath ||
            row.sha256 !== plan.sha256 ||
            row.byteSize !== plan.byteSize ||
            (row.state !== 'declared' && row.state !== 'staged')
          )
            throw new HumanGateOperationError(
              'human-gate-operation-stale',
              'Review artifact changed before publication.',
            )
          const columns = contentRefColumns.encode(ref)
          const inlineBytes = columns.inlineBytes === null ? null : Buffer.from(columns.inlineBytes)
          await tx
            .update(collaborationGateArtifacts)
            .set({
              stagedContentRefJson: columns.json,
              stagedInlineBytes: inlineBytes,
              contentRefJson: columns.json,
              contentInlineBytes: inlineBytes,
              updatedAt: now,
            })
            .where(
              and(
                eq(collaborationGateArtifacts.operationId, plan.operationId),
                eq(collaborationGateArtifacts.artifactKey, plan.artifactKey),
              ),
            )
        },
      )
      return canonicalHumanGateValueJson({
        kind: 'review-content-v2',
        operationId: plan.operationId,
        artifactKey: plan.artifactKey,
        finalContentKey: plan.finalPath,
        sha256: plan.sha256,
        byteSize: plan.byteSize,
      })
    },
    async finalizeReviewArtifact(artifact) {
      const row = await load(artifact)
      await readHumanGateArtifactContent(input.content, row)
      return canonicalHumanGateValueJson({
        kind: 'review-content-v2',
        operationId: artifact.operationId,
        artifactKey: artifact.artifactKey,
        finalContentKey: artifact.finalPath,
        sha256: artifact.sha256,
        byteSize: artifact.byteSize,
      })
    },
    async cleanupReviewArtifact(artifact) {
      await databaseSessionFor(input.db).transaction(async (tx) => {
        const row = await artifactByKey(tx, artifact.operationId, artifact.artifactKey)
        if (row.state === 'consumed' || row.state === 'finalized')
          throw new HumanGateOperationError(
            'human-gate-operation-stale',
            'Committed review content cannot be cleaned.',
          )
        const operation = await operationById(tx, row.operationId)
        const receipt = row.receiptJson === null ? null : JSON.parse(row.receiptJson)
        if (operation.schemaVersion === 1 || receipt?.kind === 'cs-review-object-v2') {
          // Epoch-1 hosted publications keep their original key and stored fence.
          // Declared rows have no receipt yet, but the key is already deterministic.
          await input.content.publications.release(
            tx,
            {
              owner: 'collaboration-review',
              keys: [`${row.operationId}/${sha256Hex(row.artifactKey)}`],
            },
            Date.now(),
          )
        } else if (row.contentRefJson !== null) {
          const publication = await createContentPublicationLedger(tx).find({
            owner: 'collaboration-review',
            logicalKey: row.finalContentKey,
          })
          if (publication !== null) {
            if (publication.attempt !== row.operationId)
              throw new Error('human-gate-content-publication-attempt-mismatch')
            await input.content.release(tx, {
              publication: {
                owner: publication.owner,
                logicalKey: publication.logicalKey,
                attempt: publication.attempt,
                epoch: publication.epoch,
              },
              ref: artifactContent(row),
            })
          }
        } else
          await input.content.publications.release(
            tx,
            { owner: 'collaboration-review', keys: [row.finalContentKey] },
            Date.now(),
          )
      })
    },
  }
}
