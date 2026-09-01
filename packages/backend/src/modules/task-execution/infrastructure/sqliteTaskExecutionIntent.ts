import { and, eq, inArray, isNull } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import { taskExecutionIntents, taskExecutionMaintenanceMembers, tasks } from '@/db/schema'
import { dbTxSync, type DbTxSync } from '@/db/txSync'
import type {
  SubmittedTaskExecutionIntent,
  TaskExecutionIntentStore,
} from './taskExecutionIntentTransactionStore'
import { TaskExecutionError } from '../application/taskExecutionError'
import {
  canonicalJson,
  continuationRequestHash,
  decodeLineageSlotPath,
  encodeLineageSlotPath,
  type CanonicalContinuationRequest,
} from '../domain/executionIntent'

const MAX_INTENT_PAYLOAD_BYTES = 64 * 1024

function encodedIntentPayload(request: CanonicalContinuationRequest): string {
  const payload = canonicalJson(request.payload)
  if (Buffer.byteLength(payload) > MAX_INTENT_PAYLOAD_BYTES) {
    throw new TaskExecutionError(
      'task-continuation-conflict',
      'task continuation payload exceeds the internal 64 KiB limit',
    )
  }
  return payload
}

export class SqliteTaskExecutionIntentStore implements TaskExecutionIntentStore {
  hasPendingGateSuccessor(input: { db: DbClient; taskId: string }): boolean {
    return (
      input.db
        .select({ id: taskExecutionIntents.id })
        .from(taskExecutionIntents)
        .where(
          and(
            eq(taskExecutionIntents.taskId, input.taskId),
            eq(taskExecutionIntents.kind, 'gate-continuation'),
            eq(taskExecutionIntents.state, 'pending'),
          ),
        )
        .limit(1)
        .get() !== undefined
    )
  }

  submit(input: {
    db: DbClient
    request: CanonicalContinuationRequest
    intentId?: string
    replayAuthorizationId?: string | null
    authorizationScopeJson?: string | null
    admissionMode?: 'exclusive' | 'successor-after-claimed'
    now?: number
  }): SubmittedTaskExecutionIntent {
    const intentId = input.intentId ?? ulid()
    const now = input.now ?? Date.now()
    return dbTxSync(input.db, (tx) =>
      this.submitTx({
        tx,
        request: input.request,
        intentId,
        replayAuthorizationId: input.replayAuthorizationId ?? null,
        authorizationScopeJson: input.authorizationScopeJson ?? null,
        admissionMode: input.admissionMode ?? 'exclusive',
        now,
      }),
    )
  }

  submitTx(input: {
    tx: DbTxSync
    request: CanonicalContinuationRequest
    intentId: string
    replayAuthorizationId: string | null
    authorizationScopeJson: string | null
    admissionMode?: 'exclusive' | 'successor-after-claimed'
    now: number
  }): SubmittedTaskExecutionIntent {
    const { tx, request } = input
    const task = tx
      .select({
        lifecycleEventRevision: tasks.lifecycleEventRevision,
        executionLineageId: tasks.executionLineageId,
        lineageSlotPathJson: tasks.lineageSlotPathJson,
      })
      .from(tasks)
      .where(eq(tasks.id, request.taskId))
      .get()
    if (task === undefined) {
      throw new TaskExecutionError(
        'task-continuation-stale',
        `task '${request.taskId}' does not exist`,
      )
    }
    if (task.lifecycleEventRevision !== request.expectedTaskRevision) {
      throw new TaskExecutionError(
        'task-continuation-stale',
        `task '${request.taskId}' changed before continuation admission`,
        {
          expectedRevision: request.expectedTaskRevision,
          currentRevision: task.lifecycleEventRevision,
        },
      )
    }
    const maintenance = tx
      .select({ claimId: taskExecutionMaintenanceMembers.claimId })
      .from(taskExecutionMaintenanceMembers)
      .where(
        and(
          eq(taskExecutionMaintenanceMembers.taskId, request.taskId),
          isNull(taskExecutionMaintenanceMembers.releasedAt),
        ),
      )
      .get()
    if (maintenance !== undefined) {
      throw new TaskExecutionError(
        'task-terminal-maintenance-conflict',
        `task '${request.taskId}' is claimed by terminal maintenance`,
        { claimRef: maintenance.claimId },
      )
    }

    const hash = continuationRequestHash(request)
    const active = tx
      .select({
        id: taskExecutionIntents.id,
        requestHash: taskExecutionIntents.requestHash,
        state: taskExecutionIntents.state,
      })
      .from(taskExecutionIntents)
      .where(
        and(
          eq(taskExecutionIntents.taskId, request.taskId),
          inArray(taskExecutionIntents.state, ['pending', 'claimed']),
        ),
      )
      .limit(2)
      .all()
    const replay = active.find((intent) => intent.requestHash === hash)
    if (replay !== undefined) {
      return {
        intentId: replay.id,
        state: replay.state,
        idempotent: true,
        requestHash: hash,
      }
    }
    const pending = active.find((intent) => intent.state === 'pending')
    const claimed = active.find((intent) => intent.state === 'claimed')
    if (
      pending !== undefined ||
      (claimed !== undefined && input.admissionMode !== 'successor-after-claimed')
    ) {
      const winner = pending ?? claimed
      if (winner !== undefined) {
        throw new TaskExecutionError(
          'task-continuation-conflict',
          `task '${request.taskId}' already has an active continuation`,
          { winnerIntentRef: winner.id },
        )
      }
    }

    // SQLite's json_object/json_array migration helpers preserve insertion
    // order, while encodeLineageSlotPath deliberately canonicalizes object
    // keys.  Compare the decoded path canonically so migrated tasks and new
    // application-written tasks have identical continuation semantics.
    const storedSlotPathJson =
      task.lineageSlotPathJson === null
        ? null
        : encodeLineageSlotPath(decodeLineageSlotPath(task.lineageSlotPathJson))
    if (
      request.scope.executionLineageId !== task.executionLineageId ||
      encodeLineageSlotPath(request.scope.slotPath) !== storedSlotPathJson
    ) {
      throw new TaskExecutionError(
        'task-continuation-stale',
        `task '${request.taskId}' lineage changed before continuation admission`,
      )
    }
    tx.insert(taskExecutionIntents)
      .values({
        id: input.intentId,
        taskId: request.taskId,
        kind: request.kind,
        state: 'pending',
        source: request.source,
        requestHash: hash,
        payloadJson: encodedIntentPayload(request),
        executionLineageId: request.scope.executionLineageId,
        continuationSlotKey: request.scope.continuationSlotKey,
        slotPathJson: encodeLineageSlotPath(request.scope.slotPath),
        operationGeneration: request.scope.operationGeneration,
        replayAuthorizationId: input.replayAuthorizationId,
        authorizationScopeJson: input.authorizationScopeJson,
        expectedTaskRevision: request.expectedTaskRevision,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .run()
    return {
      intentId: input.intentId,
      state: 'pending',
      idempotent: false,
      requestHash: hash,
    }
  }
}
