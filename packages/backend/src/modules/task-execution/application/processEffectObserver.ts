// RFC-328 — task-owned managed-process logical effect coordinator.

import { createHash } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import type { DbTxSync } from '@/db/txSync'
import { nodeRuns, taskExecutionEffectAttempts, taskExecutionEffects, tasks } from '@/db/schema'
import { taskExecutionModule } from '../composition'
import {
  operationFamilyKey,
  requestHash,
  type TaskExecutionAttemptState,
} from '../domain/executionEffect'
import {
  decodeLineageSlotPath,
  encodeLineageSlotPath,
  type LineageSlot,
} from '../domain/executionIntent'
import { currentTaskExecutionContext, type TaskExecutionContext } from './taskExecutionContext'
import { TaskExecutionError } from './taskExecutionError'

const PROCESS_CLASSIFIER_VERSION = 'rfc328-managed-process-v1'
const PROCESS_TRANSPORT_POLICY_VERSION = 'rfc328-preactivation-v1'

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export interface ProcessSpawnReceipt {
  readonly pid: number
  readonly spawnBinaryPath: string
  readonly launchNonce?: string
}

export interface ProcessSettlement {
  readonly outcome: string
  readonly exitCode: number | null
  readonly pid: number | null
  readonly launchNonce?: string
  readonly drainTimedOut?: boolean
  readonly pumpError?: string
}

export interface ProcessEffectAttemptObserver {
  /** Durable logical effect + attempt + all resource holds, before launcher spawn. */
  beforeSpawn(): void
  /** Persist process/effect receipt and the caller's node receipt in one owned tx. */
  recordSpawnReceipt(receipt: ProcessSpawnReceipt, companion: (tx: DbTxSync) => void): void
  /** Settle only after managedProcess has reaped or explicitly reported unreaped. */
  settle(result: ProcessSettlement): void
}

interface PreparedHandle {
  readonly effectId: string
  readonly attemptId: string
}

export function createProcessEffectAttemptObserver(input: {
  db: DbClient
  taskId: string
  nodeRunId: string
  processKind: 'agent' | 'script'
  argv: readonly string[]
  cwd: string
  /** Shared workspace/isolation resources in addition to the per-run process key. */
  resourceKeys?: readonly string[]
  context?: TaskExecutionContext
}): ProcessEffectAttemptObserver | undefined {
  const context = input.context ?? currentTaskExecutionContext(input.taskId)
  if (context === undefined) return undefined

  const task = input.db
    .select({
      executionLineageId: tasks.executionLineageId,
      lineageSlotPathJson: tasks.lineageSlotPathJson,
      workflowVersion: tasks.workflowVersion,
    })
    .from(tasks)
    .where(eq(tasks.id, input.taskId))
    .get()
  const run = input.db
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
    .get()
  if (task === undefined || run === undefined) {
    throw new TaskExecutionError(
      'task-continuation-stale',
      `cannot prepare process effect for missing task/run '${input.taskId}/${input.nodeRunId}'`,
    )
  }

  const executionLineageId = task.executionLineageId ?? input.taskId
  const fallbackPath: readonly LineageSlot[] = [
    {
      stableNodeKey: 'task-root',
      frozenOccurrenceKey: executionLineageId,
      workflowRevision: task.workflowVersion,
    },
    {
      stableNodeKey: run.nodeId,
      frozenOccurrenceKey:
        run.continuationSlotKey ??
        `${run.nodeId}:${run.iteration}:${run.shardKey ?? ''}:${run.retryIndex}`,
      workflowRevision: task.workflowVersion,
    },
  ]
  let slotPath = fallbackPath
  try {
    if (run.lineageSlotPathJson !== null) {
      slotPath = decodeLineageSlotPath(run.lineageSlotPathJson)
    }
  } catch {
    // Imported/legacy rows use the deterministic fallback above.
  }
  const slotPathJson = encodeLineageSlotPath(slotPath)
  const slotPathDigest = sha256(slotPathJson)
  const continuationSlotKey = run.continuationSlotKey ?? sha256(slotPathJson)
  // The lineage slot already freezes node/iteration/shard identity. Keep the
  // action ordinal independent of nodeRunId/retryIndex so a manual retry is a
  // new generation of the SAME causal operation family, including after a
  // child row was deleted and reconstructed.
  const stableActionOrdinal = `managed-${input.processKind}`
  const familyKey = operationFamilyKey({
    executionLineageId,
    slotPath,
    effectKind: 'process',
    stableActionOrdinal,
  })
  const operationKey = `${continuationSlotKey}:process:${input.processKind}`
  const effectRequestHash = requestHash({
    v: 1,
    processKind: input.processKind,
    argv: input.argv,
    cwd: input.cwd,
  })
  const resources = [`process:${input.taskId}:${input.nodeRunId}`, ...(input.resourceKeys ?? [])]
  let prepared: PreparedHandle | null = null

  return {
    beforeSpawn() {
      if (prepared !== null) throw new Error('process effect attempt prepared twice')
      const next = taskExecutionModule.effects.prepareAndAcquire({
        db: input.db,
        token: context.token,
        intentId: context.intentId,
        operationKey,
        executionLineageId,
        operationFamilyKey: familyKey,
        // A process family can first appear on a node row whose task/manual
        // generation is already >0 (for example a seeded failure resumed for
        // its first real dispatch). Its own family still starts at 0 and then
        // advances from live/retained effect history.
        operationGeneration: taskExecutionModule.effects.nextOperationGeneration({
          db: input.db,
          executionLineageId,
          operationFamilyKey: familyKey,
        }),
        kind: 'process',
        requestHash: effectRequestHash,
        slotPathJson,
        slotPathDigest,
        candidateId: `${input.processKind}:${input.nodeRunId}`,
        recoveryClass: 'managed-process-preactivation',
        classifierVersion: PROCESS_CLASSIFIER_VERSION,
        transportPolicyVersion: PROCESS_TRANSPORT_POLICY_VERSION,
        retryAuthority: 'none',
        resourceKeys: resources,
      })
      prepared = { effectId: next.effectId, attemptId: next.attemptId }
    },

    recordSpawnReceipt(receipt, companion) {
      if (prepared === null) throw new Error('process spawn receipt preceded effect preparation')
      if (receipt.launchNonce === undefined || receipt.launchNonce.length === 0) {
        throw new Error('task-owned process spawn receipt lacks launch nonce')
      }
      const handle = prepared
      taskExecutionModule.ownership.withOwnedTaskTx({
        db: input.db,
        token: context.token,
        now: Date.now(),
        run: (tx) => {
          const attempt = tx
            .select({
              state: taskExecutionEffectAttempts.state,
              epoch: taskExecutionEffectAttempts.epoch,
              effectTaskId: taskExecutionEffects.taskId,
            })
            .from(taskExecutionEffectAttempts)
            .innerJoin(
              taskExecutionEffects,
              eq(taskExecutionEffects.id, taskExecutionEffectAttempts.effectId),
            )
            .where(
              and(
                eq(taskExecutionEffectAttempts.id, handle.attemptId),
                eq(taskExecutionEffectAttempts.effectId, handle.effectId),
              ),
            )
            .get()
          if (
            attempt === undefined ||
            attempt.state !== 'acting' ||
            attempt.epoch !== context.token.epoch ||
            attempt.effectTaskId !== input.taskId
          ) {
            throw new TaskExecutionError(
              'task-execution-stale-owner',
              `process attempt '${handle.attemptId}' receipt was fenced`,
            )
          }
          const updated = tx
            .update(taskExecutionEffectAttempts)
            .set({
              receiptJson: JSON.stringify({
                v: 1,
                phase: 'spawn-receipt',
                pid: receipt.pid,
                spawnBinaryPath: receipt.spawnBinaryPath,
                launchNonce: receipt.launchNonce,
              }),
              updatedAt: Date.now(),
            })
            .where(
              and(
                eq(taskExecutionEffectAttempts.id, handle.attemptId),
                eq(taskExecutionEffectAttempts.state, 'acting'),
                eq(taskExecutionEffectAttempts.epoch, context.token.epoch),
              ),
            )
            .returning({ id: taskExecutionEffectAttempts.id })
            .get()
          if (updated === undefined) {
            throw new TaskExecutionError(
              'task-execution-stale-owner',
              `process attempt '${handle.attemptId}' receipt update lost`,
            )
          }
          companion(tx)
        },
      })
    },

    settle(result) {
      if (prepared === null) return
      const handle = prepared
      const state: Exclude<TaskExecutionAttemptState, 'prepared' | 'acting' | 'outcome-unknown'> =
        result.outcome === 'child-unkillable' || result.outcome === 'unreaped'
          ? 'recovery-required'
          : result.outcome === 'spawn-failed'
            ? 'failed-not-applied'
            : 'succeeded'
      taskExecutionModule.effects.settle({
        db: input.db,
        token: context.token,
        effectId: handle.effectId,
        attemptId: handle.attemptId,
        state,
        applicationEvidence:
          state === 'succeeded'
            ? 'applied'
            : state === 'failed-not-applied'
              ? 'definitely-not-applied'
              : 'ambiguous',
        retryAuthority: 'none',
        receiptJson: JSON.stringify({
          v: 1,
          phase: 'reaped',
          outcome: result.outcome,
          exitCode: result.exitCode,
          pid: result.pid,
          launchNonce: result.launchNonce ?? null,
          drainTimedOut: result.drainTimedOut === true,
          pumpError: result.pumpError ?? null,
        }),
        failureCode:
          state === 'succeeded'
            ? null
            : result.outcome === 'child-unkillable' || result.outcome === 'unreaped'
              ? 'process-child-unkillable'
              : 'process-not-activated',
      })
    },
  }
}
