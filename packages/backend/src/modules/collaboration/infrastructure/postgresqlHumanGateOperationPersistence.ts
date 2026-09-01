// RFC-349 — PostgreSQL implementation of the collaboration operation journal.
// Each method owns its transaction; no provider transaction reaches application.

import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, ne, or, sql } from 'drizzle-orm'
import { collaborationGateArtifacts, collaborationGateOperations } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  BeginHumanGateOperationInput,
  BegunHumanGateOperation,
  HumanGateArtifactSnapshot,
  HumanGateOperationStore,
} from '../application/ports/humanGateOperationStore'
import {
  DEFAULT_HUMAN_GATE_CLAIM_LEASE_MS,
  type HumanGateArtifactDeclaration,
} from './humanGateOperationTransactionStore'
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

type PgTx = Parameters<Parameters<PostgresqlDatabaseClient['transaction']>[0]>[0]
type OperationRow = typeof collaborationGateOperations.$inferSelect
type ArtifactRow = typeof collaborationGateArtifacts.$inferSelect

const ACTIVE_STATES = ['preparing', 'prepared', 'committed', 'cleanup_pending'] as const
const ARTIFACT_TRANSITIONS = {
  declared: ['staged', 'cleanup_pending'],
  staged: ['consumed', 'cleanup_pending'],
  consumed: ['finalized', 'cleanup_pending'],
  finalized: [],
  cleanup_pending: [],
} as const satisfies Record<HumanGateArtifactState, readonly HumanGateArtifactState[]>

function operationSnapshot(row: OperationRow): HumanGateOperationSnapshot {
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

function mutationCount(result: unknown): number | undefined {
  return (result as { readonly changes?: number }).changes
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

function assertBegin(input: BeginHumanGateOperationInput): void {
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

function assertArtifactDeclarations(
  operationId: string,
  artifacts: readonly HumanGateArtifactDeclaration[],
): void {
  const seen = new Set<string>()
  for (const artifact of artifacts) {
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
        { operationId, artifactKey: artifact.artifactKey },
      )
    }
    seen.add(artifact.artifactKey)
  }
}

async function operationById(tx: PgTx, operationId: string): Promise<OperationRow> {
  const rows = await tx
    .select()
    .from(collaborationGateOperations)
    .where(eq(collaborationGateOperations.id, operationId))
    .limit(1)
  const row = rows[0]
  if (row !== undefined) return row
  throw new HumanGateOperationError(
    'human-gate-operation-not-found',
    `human-gate operation '${operationId}' does not exist`,
    { operationId },
  )
}

function stale(row: OperationRow, expectedClaimEpoch: number): never {
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

async function retrySerializable<T>(db: PostgresqlDatabaseClient, body: (tx: PgTx) => Promise<T>) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await db.transaction(async (tx) => {
        await tx.run(sql.raw('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE'))
        return await body(tx)
      })
    } catch (error) {
      if (attempt < 2 && retryable(error)) continue
      throw error
    }
  }
}

function retryable(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 4 && current !== null && typeof current === 'object'; depth += 1) {
    const code = (current as { readonly code?: unknown }).code
    if (code === '40001' || code === '40P01') return true
    current = (current as { readonly cause?: unknown }).cause
  }
  return false
}

export class PostgresqlHumanGateOperationPersistence implements HumanGateOperationStore {
  constructor(private readonly db: PostgresqlDatabaseClient) {}

  async begin(input: BeginHumanGateOperationInput): Promise<BegunHumanGateOperation> {
    assertBegin(input)
    assertArtifactDeclarations(input.operationId, input.artifacts ?? [])
    return await retrySerializable(this.db, async (tx) => {
      const requestHash = canonicalHumanGateRequestHash(input.request)
      const replayRows = await tx
        .select()
        .from(collaborationGateOperations)
        .where(
          and(
            eq(collaborationGateOperations.taskId, input.request.taskId),
            eq(collaborationGateOperations.gateKind, input.request.gateKind),
            eq(collaborationGateOperations.operationKind, input.request.operationKind),
            eq(collaborationGateOperations.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1)
      const replay = replayRows[0]
      if (replay !== undefined) {
        assertHumanGateIdempotencyMatch(replay, {
          requestHash,
          actorUserId: input.request.actorUserId,
        })
        return { operation: operationSnapshot(replay), replayed: true }
      }
      const winnerRows = await tx
        .select({ id: collaborationGateOperations.id })
        .from(collaborationGateOperations)
        .where(
          and(
            eq(collaborationGateOperations.taskId, input.request.taskId),
            eq(collaborationGateOperations.gateKind, input.request.gateKind),
            eq(collaborationGateOperations.gateRef, input.request.gateRef),
            eq(collaborationGateOperations.operationKind, input.request.operationKind),
            inArray(collaborationGateOperations.state, ACTIVE_STATES),
          ),
        )
        .limit(1)
      if (winnerRows[0] !== undefined) {
        throw new HumanGateOperationError(
          'human-gate-operation-conflict',
          `human-gate '${input.request.gateRef}' already has an active operation`,
          { winnerOperationId: winnerRows[0].id },
        )
      }
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
      if ((input.artifacts?.length ?? 0) > 0) {
        await tx
          .insert(collaborationGateArtifacts)
          .values(
            input.artifacts!.map((artifact) => ({
              operationId: input.operationId,
              artifactKey: artifact.artifactKey,
              artifactKind: 'review-doc' as const,
              stagedPath: artifact.stagedPath,
              finalPath: artifact.finalPath,
              sha256: artifact.sha256,
              byteSize: artifact.byteSize,
              state: 'declared' as const,
              receiptJson: null,
              updatedAt: input.now,
            })),
          )
          .run()
      }
      if (input.preparedManifestJson !== undefined) {
        assertHumanGateManifestJson(input.preparedManifestJson)
        await tx
          .update(collaborationGateOperations)
          .set({
            state: 'prepared',
            manifestJson: input.preparedManifestJson,
            claimExpiresAt: input.now + DEFAULT_HUMAN_GATE_CLAIM_LEASE_MS,
            updatedAt: input.now,
          })
          .where(eq(collaborationGateOperations.id, input.operationId))
          .run()
      }
      return {
        operation: operationSnapshot(await operationById(tx, input.operationId)),
        replayed: false,
      }
    })
  }

  async findByIdempotency(
    input: Parameters<HumanGateOperationStore['findByIdempotency']>[0],
  ): Promise<HumanGateOperationSnapshot | null> {
    const rows = await this.db
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
      .limit(1)
    return rows[0] === undefined ? null : operationSnapshot(rows[0])
  }

  async latestGateRevision(
    input: Parameters<HumanGateOperationStore['latestGateRevision']>[0],
  ): Promise<number> {
    const rows = await this.db
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
    return rows[0]?.revision ?? 0
  }

  async get(operationId: string): Promise<HumanGateOperationSnapshot | null> {
    const rows = await this.db
      .select()
      .from(collaborationGateOperations)
      .where(eq(collaborationGateOperations.id, operationId))
      .limit(1)
    return rows[0] === undefined ? null : operationSnapshot(rows[0])
  }

  async listArtifacts(operationId: string): Promise<readonly HumanGateArtifactSnapshot[]> {
    const rows = await this.db
      .select()
      .from(collaborationGateArtifacts)
      .where(eq(collaborationGateArtifacts.operationId, operationId))
      .orderBy(asc(collaborationGateArtifacts.artifactKey))
    return rows.map(artifactSnapshot)
  }

  async claimRecoveryBatch(
    input: Parameters<HumanGateOperationStore['claimRecoveryBatch']>[0],
  ): Promise<readonly HumanGateOperationSnapshot[]> {
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
    return await retrySerializable(this.db, async (tx) => {
      const due = await tx
        .select()
        .from(collaborationGateOperations)
        .where(
          and(
            inArray(collaborationGateOperations.state, ACTIVE_STATES),
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
        if (mutationCount(result) === 1) {
          claimed.push(operationSnapshot(await operationById(tx, row.id)))
        }
      }
      return claimed
    })
  }

  async renewRecoveryClaim(
    input: Parameters<HumanGateOperationStore['renewRecoveryClaim']>[0],
  ): Promise<HumanGateOperationSnapshot> {
    return await this.mutateOperation(input.operationId, input.expectedClaimEpoch, async (tx) => {
      const result = await tx
        .update(collaborationGateOperations)
        .set({ claimExpiresAt: input.now + input.leaseMs, updatedAt: input.now })
        .where(
          and(
            eq(collaborationGateOperations.id, input.operationId),
            inArray(collaborationGateOperations.state, ACTIVE_STATES),
            eq(collaborationGateOperations.claimEpoch, input.expectedClaimEpoch),
          ),
        )
        .run()
      if (mutationCount(result) !== 1)
        stale(await operationById(tx, input.operationId), input.expectedClaimEpoch)
    })
  }

  async markPrepared(
    input: Parameters<HumanGateOperationStore['markPrepared']>[0],
  ): Promise<HumanGateOperationSnapshot> {
    assertHumanGateManifestJson(input.manifestJson)
    return await this.mutateOperation(input.operationId, input.expectedClaimEpoch, async (tx) => {
      const row = await operationById(tx, input.operationId)
      assertHumanGateOperationTransition(row.state, 'prepared')
      const unstaged = await tx
        .select({ artifactKey: collaborationGateArtifacts.artifactKey })
        .from(collaborationGateArtifacts)
        .where(
          and(
            eq(collaborationGateArtifacts.operationId, input.operationId),
            ne(collaborationGateArtifacts.state, 'staged'),
          ),
        )
        .limit(1)
      if (unstaged[0] !== undefined) {
        throw new HumanGateOperationError(
          'human-gate-operation-manifest-invalid',
          `human-gate artifact '${unstaged[0].artifactKey}' is not staged`,
          { operationId: input.operationId, artifactKey: unstaged[0].artifactKey },
        )
      }
      const result = await tx
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
      if (mutationCount(result) !== 1)
        stale(await operationById(tx, input.operationId), input.expectedClaimEpoch)
    })
  }

  async commit(
    input: Parameters<HumanGateOperationStore['commit']>[0],
  ): Promise<HumanGateOperationSnapshot> {
    assertJson(input.receiptJson, 'human-gate operation receipt')
    return await this.mutateOperation(input.operationId, input.expectedClaimEpoch, async (tx) => {
      const row = await operationById(tx, input.operationId)
      if (row.state === 'committed' || row.state === 'completed') {
        if (row.claimEpoch === input.expectedClaimEpoch && row.receiptJson === input.receiptJson)
          return
        stale(row, input.expectedClaimEpoch)
      }
      assertHumanGateOperationTransition(row.state, 'committed')
      const unready = await tx
        .select({ artifactKey: collaborationGateArtifacts.artifactKey })
        .from(collaborationGateArtifacts)
        .where(
          and(
            eq(collaborationGateArtifacts.operationId, input.operationId),
            ne(collaborationGateArtifacts.state, 'staged'),
          ),
        )
        .limit(1)
      if (unready[0] !== undefined) {
        throw new HumanGateOperationError(
          'human-gate-operation-manifest-invalid',
          `human-gate artifact '${unready[0].artifactKey}' is not ready for commit`,
          { operationId: input.operationId, artifactKey: unready[0].artifactKey },
        )
      }
      const result = await tx
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
      if (mutationCount(result) !== 1)
        stale(await operationById(tx, input.operationId), input.expectedClaimEpoch)
      await tx
        .update(collaborationGateArtifacts)
        .set({ state: 'consumed', updatedAt: input.now })
        .where(
          and(
            eq(collaborationGateArtifacts.operationId, input.operationId),
            eq(collaborationGateArtifacts.state, 'staged'),
          ),
        )
        .run()
    })
  }

  async complete(
    input: Parameters<HumanGateOperationStore['complete']>[0],
  ): Promise<HumanGateOperationSnapshot> {
    return await this.mutateOperation(input.operationId, input.expectedClaimEpoch, async (tx) => {
      const row = await operationById(tx, input.operationId)
      if (row.state === 'completed' && row.claimEpoch === input.expectedClaimEpoch) return
      if (row.state !== 'committed') {
        throw new HumanGateOperationError(
          'human-gate-operation-transition-invalid',
          `human-gate operation '${input.operationId}' is not committed`,
          { operationId: input.operationId, currentState: row.state },
        )
      }
      const unfinished = await tx
        .select({ artifactKey: collaborationGateArtifacts.artifactKey })
        .from(collaborationGateArtifacts)
        .where(
          and(
            eq(collaborationGateArtifacts.operationId, input.operationId),
            ne(collaborationGateArtifacts.state, 'finalized'),
          ),
        )
        .limit(1)
      if (unfinished[0] !== undefined) {
        throw new HumanGateOperationError(
          'human-gate-operation-transition-invalid',
          `human-gate artifact '${unfinished[0].artifactKey}' is not finalized`,
          { operationId: input.operationId, artifactKey: unfinished[0].artifactKey },
        )
      }
      const result = await tx
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
      if (mutationCount(result) !== 1)
        stale(await operationById(tx, input.operationId), input.expectedClaimEpoch)
    })
  }

  async markCleanupPending(
    input: Parameters<HumanGateOperationStore['markCleanupPending']>[0],
  ): Promise<HumanGateOperationSnapshot> {
    return await this.mutateOperation(input.operationId, input.expectedClaimEpoch, async (tx) => {
      const row = await operationById(tx, input.operationId)
      if (row.state !== 'preparing' && row.state !== 'prepared') {
        throw new HumanGateOperationError(
          'human-gate-operation-transition-invalid',
          `human-gate operation '${input.operationId}' cannot enter cleanup from '${row.state}'`,
          { operationId: input.operationId, currentState: row.state },
        )
      }
      const result = await tx
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
      if (mutationCount(result) !== 1)
        stale(await operationById(tx, input.operationId), input.expectedClaimEpoch)
      await tx
        .update(collaborationGateArtifacts)
        .set({ state: 'cleanup_pending', updatedAt: input.now })
        .where(
          and(
            eq(collaborationGateArtifacts.operationId, input.operationId),
            inArray(collaborationGateArtifacts.state, ['declared', 'staged']),
          ),
        )
        .run()
    })
  }

  async completeCleanup(
    input: Parameters<HumanGateOperationStore['completeCleanup']>[0],
  ): Promise<HumanGateOperationSnapshot> {
    assertJson(input.failureJson, 'human-gate cleanup result')
    return await this.mutateOperation(input.operationId, input.expectedClaimEpoch, async (tx) => {
      const row = await operationById(tx, input.operationId)
      if (row.state !== 'cleanup_pending' || row.claimEpoch !== input.expectedClaimEpoch) {
        stale(row, input.expectedClaimEpoch)
      }
      await tx
        .delete(collaborationGateArtifacts)
        .where(
          and(
            eq(collaborationGateArtifacts.operationId, input.operationId),
            eq(collaborationGateArtifacts.state, 'cleanup_pending'),
          ),
        )
        .run()
      const remaining = await tx
        .select({ artifactKey: collaborationGateArtifacts.artifactKey })
        .from(collaborationGateArtifacts)
        .where(eq(collaborationGateArtifacts.operationId, input.operationId))
        .limit(1)
      if (remaining[0] !== undefined) {
        throw new HumanGateOperationError(
          'human-gate-operation-transition-invalid',
          `human-gate artifact '${remaining[0].artifactKey}' has not been cleaned`,
          { operationId: input.operationId, artifactKey: remaining[0].artifactKey },
        )
      }
      const result = await tx
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
      if (mutationCount(result) !== 1)
        stale(await operationById(tx, input.operationId), input.expectedClaimEpoch)
    })
  }

  async transitionArtifact(
    input: Parameters<HumanGateOperationStore['transitionArtifact']>[0],
  ): Promise<void> {
    await retrySerializable(this.db, async (tx) => {
      if (input.expectedClaimEpoch !== undefined) {
        const operation = await operationById(tx, input.operationId)
        if (operation.claimEpoch !== input.expectedClaimEpoch)
          stale(operation, input.expectedClaimEpoch)
      }
      if (input.receiptJson !== undefined && input.receiptJson !== null) {
        assertJson(input.receiptJson, 'human-gate artifact receipt')
      }
      const rows = await tx
        .select()
        .from(collaborationGateArtifacts)
        .where(
          and(
            eq(collaborationGateArtifacts.operationId, input.operationId),
            eq(collaborationGateArtifacts.artifactKey, input.artifactKey),
          ),
        )
        .limit(1)
      const row = rows[0]
      if (row === undefined) {
        throw new HumanGateOperationError(
          'human-gate-operation-not-found',
          `human-gate artifact '${input.operationId}/${input.artifactKey}' does not exist`,
          { operationId: input.operationId, artifactKey: input.artifactKey },
        )
      }
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
      if (
        !(ARTIFACT_TRANSITIONS[row.state] as readonly HumanGateArtifactState[]).includes(input.to)
      ) {
        throw new HumanGateOperationError(
          'human-gate-operation-transition-invalid',
          `human-gate artifact cannot transition from '${row.state}' to '${input.to}'`,
          { from: row.state, to: input.to },
        )
      }
      if ((input.to === 'staged' || input.to === 'finalized') && input.receiptJson == null) {
        throw new HumanGateOperationError(
          'human-gate-operation-manifest-invalid',
          `human-gate artifact '${input.artifactKey}' requires a transition receipt`,
          { operationId: input.operationId, artifactKey: input.artifactKey },
        )
      }
      const result = await tx
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
      if (mutationCount(result) !== 1) {
        throw new HumanGateOperationError(
          'human-gate-operation-stale',
          `human-gate artifact '${input.artifactKey}' changed before mutation`,
          { operationId: input.operationId, artifactKey: input.artifactKey },
        )
      }
    })
  }

  private async mutateOperation(
    operationId: string,
    expectedClaimEpoch: number,
    body: (tx: PgTx) => Promise<void>,
  ): Promise<HumanGateOperationSnapshot> {
    return await retrySerializable(this.db, async (tx) => {
      await body(tx)
      const row = await operationById(tx, operationId)
      if (row.claimEpoch !== expectedClaimEpoch) stale(row, expectedClaimEpoch)
      return operationSnapshot(row)
    })
  }
}
