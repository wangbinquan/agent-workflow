import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, ne, or } from 'drizzle-orm'

import { collaborationGateArtifacts, collaborationGateOperations } from '@/db/schema'
import type { DbTxSync } from '@/db/txSync'
import type {
  BeginHumanGateOperationTxInput,
  BegunHumanGateOperation,
  HumanGateArtifactSnapshot,
  HumanGateOperationTransactionStore,
} from './humanGateOperationTransactionStore'
import { DEFAULT_HUMAN_GATE_CLAIM_LEASE_MS } from './humanGateOperationTransactionStore'
import {
  canonicalHumanGateRequestHash,
  canonicalHumanGateJson,
} from '../domain/canonicalGateRequest'
import {
  assertHumanGateIdempotencyMatch,
  assertHumanGateManifestJson,
  assertHumanGateOperationTransition,
  HumanGateOperationError,
  type HumanGateArtifactState,
  type HumanGateOperationSnapshot,
} from '../domain/humanGateOperation'

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

function changes(result: unknown): number | undefined {
  return (result as { changes?: number }).changes
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

function operationById(tx: DbTxSync, operationId: string): OperationRow {
  const row = tx
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

function assertRequest(input: BeginHumanGateOperationTxInput): void {
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

function existingIdempotency(
  tx: DbTxSync,
  input: BeginHumanGateOperationTxInput,
  requestHash: string,
): BegunHumanGateOperation | null {
  const { request } = input
  const row = tx
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

function activeOperation(
  tx: DbTxSync,
  input: BeginHumanGateOperationTxInput,
): OperationRow | undefined {
  const { request } = input
  return tx
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

function artifactByKey(tx: DbTxSync, operationId: string, artifactKey: string): ArtifactRow {
  const row = tx
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

export class SqliteHumanGateOperationStore implements HumanGateOperationTransactionStore {
  beginTx(input: BeginHumanGateOperationTxInput): BegunHumanGateOperation {
    assertRequest(input)
    const requestHash = canonicalHumanGateRequestHash(input.request)
    const replay = existingIdempotency(input.tx, input, requestHash)
    if (replay !== null) return replay

    const winner = activeOperation(input.tx, input)
    if (winner !== undefined) {
      throw new HumanGateOperationError(
        'human-gate-operation-conflict',
        `human-gate '${input.request.gateRef}' already has an active operation`,
        { winnerOperationId: winner.id },
      )
    }

    try {
      input.tx
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
      const racedReplay = existingIdempotency(input.tx, input, requestHash)
      if (racedReplay !== null) return racedReplay
      const racedWinner = activeOperation(input.tx, input)
      if (racedWinner !== undefined) {
        throw new HumanGateOperationError(
          'human-gate-operation-conflict',
          `human-gate '${input.request.gateRef}' already has an active operation`,
          { winnerOperationId: racedWinner.id },
        )
      }
      throw error
    }
    return { operation: snapshot(operationById(input.tx, input.operationId)), replayed: false }
  }

  findByIdempotencyTx(
    input: Parameters<HumanGateOperationTransactionStore['findByIdempotencyTx']>[0],
  ): HumanGateOperationSnapshot | null {
    const row = input.tx
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

  latestGateRevisionTx(
    input: Parameters<HumanGateOperationTransactionStore['latestGateRevisionTx']>[0],
  ): number {
    const row = input.tx
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

  getTx(tx: DbTxSync, operationId: string): HumanGateOperationSnapshot | null {
    const row = tx
      .select()
      .from(collaborationGateOperations)
      .where(eq(collaborationGateOperations.id, operationId))
      .get()
    return row === undefined ? null : snapshot(row)
  }

  listArtifactsTx(tx: DbTxSync, operationId: string): readonly HumanGateArtifactSnapshot[] {
    return tx
      .select()
      .from(collaborationGateArtifacts)
      .where(eq(collaborationGateArtifacts.operationId, operationId))
      .orderBy(asc(collaborationGateArtifacts.artifactKey))
      .all()
      .map(artifactSnapshot)
  }

  claimRecoveryBatchTx(input: {
    tx: DbTxSync
    now: number
    leaseMs: number
    limit: number
  }): readonly HumanGateOperationSnapshot[] {
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
    const due = input.tx
      .select()
      .from(collaborationGateOperations)
      .where(
        and(
          inArray(collaborationGateOperations.state, ACTIVE_OPERATION_STATES),
          // A prepared manual-question operation is an intentional durable
          // wait for the active task owner, not abandoned preparation. Its
          // owner-settle participant, not artifact recovery, consumes it.
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
        asc(collaborationGateOperations.claimExpiresAt),
        asc(collaborationGateOperations.updatedAt),
        asc(collaborationGateOperations.id),
      )
      .limit(input.limit)
      .all()
    const claimed: HumanGateOperationSnapshot[] = []
    for (const row of due) {
      const result = input.tx
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
      if (changes(result) === 1) claimed.push(snapshot(operationById(input.tx, row.id)))
    }
    return claimed
  }

  renewRecoveryClaimTx(input: {
    tx: DbTxSync
    operationId: string
    expectedClaimEpoch: number
    now: number
    leaseMs: number
  }): HumanGateOperationSnapshot {
    const result = input.tx
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
    if (changes(result) !== 1) {
      staleOperation(operationById(input.tx, input.operationId), input.expectedClaimEpoch)
    }
    return snapshot(operationById(input.tx, input.operationId))
  }

  markPreparedTx(input: {
    tx: DbTxSync
    operationId: string
    expectedClaimEpoch: number
    manifestJson: string
    now: number
  }): HumanGateOperationSnapshot {
    assertHumanGateManifestJson(input.manifestJson)
    const row = operationById(input.tx, input.operationId)
    assertHumanGateOperationTransition(row.state, 'prepared')
    const unstaged = input.tx
      .select({ artifactKey: collaborationGateArtifacts.artifactKey })
      .from(collaborationGateArtifacts)
      .where(
        and(
          eq(collaborationGateArtifacts.operationId, input.operationId),
          ne(collaborationGateArtifacts.state, 'staged'),
        ),
      )
      .get()
    if (unstaged !== undefined) {
      throw new HumanGateOperationError(
        'human-gate-operation-manifest-invalid',
        `human-gate artifact '${unstaged.artifactKey}' is not staged`,
        { operationId: input.operationId, artifactKey: unstaged.artifactKey },
      )
    }
    const result = input.tx
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
    if (changes(result) !== 1)
      staleOperation(operationById(input.tx, input.operationId), input.expectedClaimEpoch)
    return snapshot(operationById(input.tx, input.operationId))
  }

  commitTx(input: {
    tx: DbTxSync
    operationId: string
    expectedClaimEpoch: number
    receiptJson: string
    now: number
  }): HumanGateOperationSnapshot {
    assertJson(input.receiptJson, 'human-gate operation receipt')
    const row = operationById(input.tx, input.operationId)
    if (row.state === 'committed' || row.state === 'completed') {
      if (row.claimEpoch === input.expectedClaimEpoch && row.receiptJson === input.receiptJson) {
        return snapshot(row)
      }
      staleOperation(row, input.expectedClaimEpoch)
    }
    assertHumanGateOperationTransition(row.state, 'committed')
    const unready = input.tx
      .select({ artifactKey: collaborationGateArtifacts.artifactKey })
      .from(collaborationGateArtifacts)
      .where(
        and(
          eq(collaborationGateArtifacts.operationId, input.operationId),
          ne(collaborationGateArtifacts.state, 'staged'),
        ),
      )
      .get()
    if (unready !== undefined) {
      throw new HumanGateOperationError(
        'human-gate-operation-manifest-invalid',
        `human-gate artifact '${unready.artifactKey}' is not ready for commit`,
        { operationId: input.operationId, artifactKey: unready.artifactKey },
      )
    }
    const result = input.tx
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
    if (changes(result) !== 1)
      staleOperation(operationById(input.tx, input.operationId), input.expectedClaimEpoch)
    input.tx
      .update(collaborationGateArtifacts)
      .set({ state: 'consumed', updatedAt: input.now })
      .where(
        and(
          eq(collaborationGateArtifacts.operationId, input.operationId),
          eq(collaborationGateArtifacts.state, 'staged'),
        ),
      )
      .run()
    return snapshot(operationById(input.tx, input.operationId))
  }

  completeTx(input: {
    tx: DbTxSync
    operationId: string
    expectedClaimEpoch: number
    now: number
  }): HumanGateOperationSnapshot {
    const row = operationById(input.tx, input.operationId)
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
    const unfinished = input.tx
      .select({ artifactKey: collaborationGateArtifacts.artifactKey })
      .from(collaborationGateArtifacts)
      .where(
        and(
          eq(collaborationGateArtifacts.operationId, input.operationId),
          ne(collaborationGateArtifacts.state, 'finalized'),
        ),
      )
      .get()
    if (unfinished !== undefined) {
      throw new HumanGateOperationError(
        'human-gate-operation-transition-invalid',
        `human-gate artifact '${unfinished.artifactKey}' is not finalized`,
        { operationId: input.operationId, artifactKey: unfinished.artifactKey },
      )
    }
    const result = input.tx
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
    if (changes(result) !== 1)
      staleOperation(operationById(input.tx, input.operationId), input.expectedClaimEpoch)
    return snapshot(operationById(input.tx, input.operationId))
  }

  markCleanupPendingTx(input: {
    tx: DbTxSync
    operationId: string
    expectedClaimEpoch: number
    now: number
  }): HumanGateOperationSnapshot {
    const row = operationById(input.tx, input.operationId)
    if (row.state !== 'preparing' && row.state !== 'prepared') {
      throw new HumanGateOperationError(
        'human-gate-operation-transition-invalid',
        `human-gate operation '${input.operationId}' cannot enter cleanup from '${row.state}'`,
        { operationId: input.operationId, currentState: row.state },
      )
    }
    assertHumanGateOperationTransition(row.state, 'cleanup_pending')
    const result = input.tx
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
    if (changes(result) !== 1) {
      staleOperation(operationById(input.tx, input.operationId), input.expectedClaimEpoch)
    }
    input.tx
      .update(collaborationGateArtifacts)
      .set({ state: 'cleanup_pending', updatedAt: input.now })
      .where(
        and(
          eq(collaborationGateArtifacts.operationId, input.operationId),
          inArray(collaborationGateArtifacts.state, ['declared', 'staged']),
        ),
      )
      .run()
    return snapshot(operationById(input.tx, input.operationId))
  }

  deleteCleanupArtifactsTx(input: {
    tx: DbTxSync
    operationId: string
    expectedClaimEpoch: number
  }): void {
    const operation = operationById(input.tx, input.operationId)
    if (
      operation.state !== 'cleanup_pending' ||
      operation.claimEpoch !== input.expectedClaimEpoch
    ) {
      staleOperation(operation, input.expectedClaimEpoch)
    }
    const unexpected = input.tx
      .select({ artifactKey: collaborationGateArtifacts.artifactKey })
      .from(collaborationGateArtifacts)
      .where(
        and(
          eq(collaborationGateArtifacts.operationId, input.operationId),
          ne(collaborationGateArtifacts.state, 'cleanup_pending'),
        ),
      )
      .get()
    if (unexpected !== undefined) {
      throw new HumanGateOperationError(
        'human-gate-operation-transition-invalid',
        `human-gate artifact '${unexpected.artifactKey}' is not cleanup-pending`,
        { operationId: input.operationId, artifactKey: unexpected.artifactKey },
      )
    }
    input.tx
      .delete(collaborationGateArtifacts)
      .where(eq(collaborationGateArtifacts.operationId, input.operationId))
      .run()
  }

  completeCleanupTx(input: {
    tx: DbTxSync
    operationId: string
    expectedClaimEpoch: number
    failureJson: string
    now: number
  }): HumanGateOperationSnapshot {
    assertJson(input.failureJson, 'human-gate cleanup result')
    const row = operationById(input.tx, input.operationId)
    if (row.state !== 'cleanup_pending') {
      throw new HumanGateOperationError(
        'human-gate-operation-transition-invalid',
        `human-gate operation '${input.operationId}' is not cleanup-pending`,
        { operationId: input.operationId, currentState: row.state },
      )
    }
    const remaining = input.tx
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
    const result = input.tx
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
    if (changes(result) !== 1) {
      staleOperation(operationById(input.tx, input.operationId), input.expectedClaimEpoch)
    }
    return snapshot(operationById(input.tx, input.operationId))
  }

  declareArtifactsTx(
    input: Parameters<HumanGateOperationTransactionStore['declareArtifactsTx']>[0],
  ): void {
    const operation = operationById(input.tx, input.operationId)
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
      input.tx
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

  transitionArtifactTx(
    input: Parameters<HumanGateOperationTransactionStore['transitionArtifactTx']>[0],
  ): void {
    if (input.expectedClaimEpoch !== undefined) {
      const operation = operationById(input.tx, input.operationId)
      if (operation.claimEpoch !== input.expectedClaimEpoch) {
        staleOperation(operation, input.expectedClaimEpoch)
      }
    }
    if (input.receiptJson !== undefined && input.receiptJson !== null) {
      assertJson(input.receiptJson, 'human-gate artifact receipt')
    }
    const row = artifactByKey(input.tx, input.operationId, input.artifactKey)
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
    const result = input.tx
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
    if (changes(result) !== 1) {
      throw new HumanGateOperationError(
        'human-gate-operation-stale',
        `human-gate artifact '${input.artifactKey}' changed before mutation`,
        { operationId: input.operationId, artifactKey: input.artifactKey },
      )
    }
  }
}
