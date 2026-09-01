// RFC-349 — PostgreSQL continuation admission. Task lineage, retained replay
// decisions, maintenance fencing and the new intent commit atomically.

import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { ulid } from 'ulid'

import {
  taskExecutionIntents,
  taskExecutionLineageOperationRecords,
  taskExecutionMaintenanceMembers,
  tasks,
} from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  SubmittedTaskExecutionIntent,
  SubmitTaskExecutionIntentInput,
  TaskExecutionIntentPersistence,
} from '../application/ports/taskExecutionIntentPersistence'
import { TaskExecutionError } from '../application/taskExecutionError'
import { sha256Hex } from '../domain/digest'
import {
  canonicalJson,
  continuationRequestHash,
  decodeLineageSlotPath,
  encodeLineageSlotPath,
  lineagePathHasPrefix,
  mayAuthorizeReplay,
  type CanonicalContinuationRequest,
} from '../domain/executionIntent'

type PgTx = Parameters<Parameters<PostgresqlDatabaseClient['transaction']>[0]>[0]
const MAX_INTENT_PAYLOAD_BYTES = 64 * 1024

function payloadJson(payload: unknown): string {
  const encoded = canonicalJson(payload)
  if (Buffer.byteLength(encoded) > MAX_INTENT_PAYLOAD_BYTES) {
    throw new TaskExecutionError(
      'task-continuation-conflict',
      'task continuation payload exceeds the internal 64 KiB limit',
    )
  }
  return encoded
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

async function serializable<T>(db: PostgresqlDatabaseClient, body: (tx: PgTx) => Promise<T>) {
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

async function submitCanonicalTx(
  tx: PgTx,
  input: SubmitTaskExecutionIntentInput,
  intentId: string,
  now: number,
): Promise<SubmittedTaskExecutionIntent> {
  const taskRows = await tx
    .select({
      lifecycleEventRevision: tasks.lifecycleEventRevision,
      executionLineageId: tasks.executionLineageId,
      lineageSlotPathJson: tasks.lineageSlotPathJson,
    })
    .from(tasks)
    .where(eq(tasks.id, input.request.taskId))
    .limit(1)
  const task = taskRows[0]
  if (task === undefined) {
    throw new TaskExecutionError(
      'task-continuation-stale',
      `task '${input.request.taskId}' does not exist`,
    )
  }
  if (task.lifecycleEventRevision !== input.request.expectedTaskRevision) {
    throw new TaskExecutionError(
      'task-continuation-stale',
      `task '${input.request.taskId}' changed before continuation admission`,
      {
        expectedRevision: input.request.expectedTaskRevision,
        currentRevision: task.lifecycleEventRevision,
      },
    )
  }
  const maintenance = await tx
    .select({ claimId: taskExecutionMaintenanceMembers.claimId })
    .from(taskExecutionMaintenanceMembers)
    .where(
      and(
        eq(taskExecutionMaintenanceMembers.taskId, input.request.taskId),
        isNull(taskExecutionMaintenanceMembers.releasedAt),
      ),
    )
    .limit(1)
  if (maintenance[0] !== undefined) {
    throw new TaskExecutionError(
      'task-terminal-maintenance-conflict',
      `task '${input.request.taskId}' is claimed by terminal maintenance`,
      { claimRef: maintenance[0].claimId },
    )
  }

  const hash = continuationRequestHash(input.request)
  const active = await tx
    .select({
      id: taskExecutionIntents.id,
      requestHash: taskExecutionIntents.requestHash,
      state: taskExecutionIntents.state,
    })
    .from(taskExecutionIntents)
    .where(
      and(
        eq(taskExecutionIntents.taskId, input.request.taskId),
        inArray(taskExecutionIntents.state, ['pending', 'claimed']),
      ),
    )
    .limit(2)
  const replay = active.find((intent) => intent.requestHash === hash)
  if (replay !== undefined) {
    return { intentId: replay.id, state: replay.state, idempotent: true, requestHash: hash }
  }
  const pending = active.find((intent) => intent.state === 'pending')
  const claimed = active.find((intent) => intent.state === 'claimed')
  if (
    pending !== undefined ||
    (claimed !== undefined && input.admissionMode !== 'successor-after-claimed')
  ) {
    throw new TaskExecutionError(
      'task-continuation-conflict',
      `task '${input.request.taskId}' already has an active continuation`,
      { winnerIntentRef: (pending ?? claimed)?.id },
    )
  }
  const storedSlotPathJson =
    task.lineageSlotPathJson === null
      ? null
      : encodeLineageSlotPath(decodeLineageSlotPath(task.lineageSlotPathJson))
  if (
    input.request.scope.executionLineageId !== task.executionLineageId ||
    encodeLineageSlotPath(input.request.scope.slotPath) !== storedSlotPathJson
  ) {
    throw new TaskExecutionError(
      'task-continuation-stale',
      `task '${input.request.taskId}' lineage changed before continuation admission`,
    )
  }
  await tx
    .insert(taskExecutionIntents)
    .values({
      id: intentId,
      taskId: input.request.taskId,
      kind: input.request.kind,
      state: 'pending',
      source: input.request.source,
      requestHash: hash,
      payloadJson: payloadJson(input.request.payload),
      executionLineageId: input.request.scope.executionLineageId,
      continuationSlotKey: input.request.scope.continuationSlotKey,
      slotPathJson: encodeLineageSlotPath(input.request.scope.slotPath),
      operationGeneration: input.request.scope.operationGeneration,
      replayAuthorizationId: input.replayAuthorizationId ?? null,
      authorizationScopeJson: input.authorizationScopeJson ?? null,
      expectedTaskRevision: input.request.expectedTaskRevision,
      createdAt: now,
      updatedAt: now,
    })
    .run()
  return { intentId, state: 'pending', idempotent: false, requestHash: hash }
}

/** Provider-private companion for a larger PostgreSQL use-case atom. */
export async function submitPostgresqlTaskContinuationTx(
  tx: PgTx,
  input: Parameters<TaskExecutionIntentPersistence['submitContinuation']>[0],
): Promise<SubmittedTaskExecutionIntent> {
  const taskRows = await tx
    .select({
      lifecycleEventRevision: tasks.lifecycleEventRevision,
      executionLineageId: tasks.executionLineageId,
      lineageSlotPathJson: tasks.lineageSlotPathJson,
    })
    .from(tasks)
    .where(eq(tasks.id, input.taskId))
    .limit(1)
  const task = taskRows[0]
  if (task === undefined) {
    throw new TaskExecutionError(
      'task-continuation-stale',
      `task '${input.taskId}' disappeared before continuation admission`,
    )
  }
  const latestRows = await tx
    .select({
      continuationSlotKey: taskExecutionIntents.continuationSlotKey,
      operationGeneration: taskExecutionIntents.operationGeneration,
    })
    .from(taskExecutionIntents)
    .where(eq(taskExecutionIntents.taskId, input.taskId))
    .orderBy(desc(taskExecutionIntents.createdAt), desc(taskExecutionIntents.id))
    .limit(1)
  const latest = latestRows[0]
  const executionLineageId = task.executionLineageId ?? input.taskId
  const slotPath =
    task.lineageSlotPathJson === null
      ? [
          {
            stableNodeKey: 'task-root',
            frozenOccurrenceKey: executionLineageId,
            workflowRevision: null,
          },
        ]
      : decodeLineageSlotPath(task.lineageSlotPathJson)
  const continuationSlotKey =
    latest?.continuationSlotKey ??
    sha256Hex(`${executionLineageId}\u0000${task.lineageSlotPathJson ?? input.taskId}`)
  const operationGeneration =
    (latest?.operationGeneration ?? 0) + (input.advanceOperationGeneration ? 1 : 0)
  const replayAuthorized = mayAuthorizeReplay({
    kind: input.kind,
    source: input.source,
    actorUserId: input.actorUserId,
  })
  const replayAuthorizationId = replayAuthorized ? ulid() : null
  const authorizationScopeJson = replayAuthorized
    ? canonicalJson({
        v: 1,
        executionLineageId,
        continuationSlotKey,
        slotPath,
        operationGeneration,
      })
    : null
  const retained = await tx
    .select()
    .from(taskExecutionLineageOperationRecords)
    .where(
      and(
        eq(taskExecutionLineageOperationRecords.recordKind, 'replay-decision'),
        eq(taskExecutionLineageOperationRecords.executionLineageId, executionLineageId),
        eq(taskExecutionLineageOperationRecords.decisionState, 'requires-actor'),
      ),
    )
  const selected = retained.filter((decision) => {
    try {
      return lineagePathHasPrefix(decodeLineageSlotPath(decision.slotPathJson), slotPath)
    } catch {
      throw new TaskExecutionError(
        'task-continuation-stale',
        `retained replay decision '${decision.id}' has an invalid lineage path`,
      )
    }
  })
  if (selected.length > 0 && replayAuthorizationId === null) {
    throw new TaskExecutionError(
      'task-execution-outcome-unknown',
      'this continuation includes an operation with unknown outcome; use a manual resume/retry/sync command',
      { unresolvedDecisionRefs: selected.map((decision) => decision.id) },
    )
  }
  const request: CanonicalContinuationRequest = {
    taskId: input.taskId,
    kind: input.kind,
    source: input.source,
    actorUserId: input.actorUserId,
    expectedTaskRevision: task.lifecycleEventRevision,
    scope: { executionLineageId, continuationSlotKey, slotPath, operationGeneration },
    payload: input.payload,
  }
  const submitted = await submitCanonicalTx(
    tx,
    {
      request,
      intentId: input.intentId,
      replayAuthorizationId,
      authorizationScopeJson,
      admissionMode: input.admissionMode ?? 'exclusive',
      now: input.now,
    },
    input.intentId,
    input.now,
  )
  for (const decision of selected) {
    const rebound = await tx
      .update(taskExecutionLineageOperationRecords)
      .set({
        decisionState: 'actor-replay-authorized',
        replayAuthorizationId,
        authorizationScopeJson,
        actorUserId: input.actorUserId,
        authorizationSource: input.source,
        boundIntentId: input.intentId,
        recordRevision: decision.recordRevision + 1,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(taskExecutionLineageOperationRecords.id, decision.id),
          eq(taskExecutionLineageOperationRecords.recordRevision, decision.recordRevision),
          eq(taskExecutionLineageOperationRecords.decisionState, 'requires-actor'),
        ),
      )
      .returning({ id: taskExecutionLineageOperationRecords.id })
    if (rebound[0] === undefined) {
      throw new TaskExecutionError(
        'task-continuation-stale',
        `replay decision '${decision.id}' changed during continuation admission`,
      )
    }
  }
  return submitted
}

export class PostgresqlTaskExecutionIntentPersistence implements TaskExecutionIntentPersistence {
  constructor(private readonly db: PostgresqlDatabaseClient) {}

  async hasPendingGateSuccessor(taskId: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: taskExecutionIntents.id })
      .from(taskExecutionIntents)
      .where(
        and(
          eq(taskExecutionIntents.taskId, taskId),
          eq(taskExecutionIntents.kind, 'gate-continuation'),
          eq(taskExecutionIntents.state, 'pending'),
        ),
      )
      .limit(1)
    return rows.length > 0
  }

  async submit(input: SubmitTaskExecutionIntentInput): Promise<SubmittedTaskExecutionIntent> {
    const intentId = input.intentId ?? ulid()
    const now = input.now ?? Date.now()
    return await serializable(
      this.db,
      async (tx) => await submitCanonicalTx(tx, input, intentId, now),
    )
  }

  async submitContinuation(
    input: Parameters<TaskExecutionIntentPersistence['submitContinuation']>[0],
  ): Promise<SubmittedTaskExecutionIntent> {
    return await serializable(
      this.db,
      async (tx) => await submitPostgresqlTaskContinuationTx(tx, input),
    )
  }
}
