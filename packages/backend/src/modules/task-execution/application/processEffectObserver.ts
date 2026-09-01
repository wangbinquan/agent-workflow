// RFC-349 — provider-neutral managed-process effect coordinator.

import { sha256Hex } from '../domain/digest'
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
import type { TaskExecutionEffectPersistence } from './ports/taskExecutionEffectStore'
import { currentTaskExecutionContext, type TaskExecutionContext } from './taskExecutionContext'
import { TaskExecutionError } from './taskExecutionError'
import { waitForEffectResourceTurn } from './effectResourceWait'

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
  beforeSpawn(): Promise<void>
  recordSpawnReceipt(receipt: ProcessSpawnReceipt, runtimeParamsJson?: string): Promise<void>
  settle(result: ProcessSettlement): Promise<void>
}

export function createProcessEffectAttemptObserver(input: {
  persistence: TaskExecutionEffectPersistence
  taskId: string
  nodeRunId: string
  processKind: 'agent' | 'script'
  argv: readonly string[]
  cwd: string
  resourceKeys?: readonly string[]
  context?: TaskExecutionContext
}): ProcessEffectAttemptObserver | undefined {
  const context = input.context ?? currentTaskExecutionContext(input.taskId)
  if (context === undefined) return undefined
  let prepared: { readonly effectId: string; readonly attemptId: string } | null = null

  return {
    async beforeSpawn() {
      if (prepared !== null) throw new Error('process effect attempt prepared twice')
      const lineage = await input.persistence.readLineage({
        taskId: input.taskId,
        intentId: context.intentId,
        nodeRunId: input.nodeRunId,
      })
      if (lineage === null || lineage.nodeId === null) {
        throw new TaskExecutionError(
          'task-continuation-stale',
          `cannot prepare process effect for missing task/run '${input.taskId}/${input.nodeRunId}'`,
        )
      }
      const fallbackPath: readonly LineageSlot[] = [
        {
          stableNodeKey: 'task-root',
          frozenOccurrenceKey: lineage.executionLineageId,
          workflowRevision: lineage.workflowVersion,
        },
        {
          stableNodeKey: lineage.nodeId,
          frozenOccurrenceKey:
            lineage.continuationSlotKey ||
            `${lineage.nodeId}:${lineage.iteration ?? 0}:${lineage.shardKey ?? ''}:${lineage.retryIndex ?? 0}`,
          workflowRevision: lineage.workflowVersion,
        },
      ]
      let slotPath = fallbackPath
      try {
        slotPath = decodeLineageSlotPath(lineage.slotPathJson)
      } catch {
        // Imported legacy rows use the deterministic fallback.
      }
      const slotPathJson = encodeLineageSlotPath(slotPath)
      const stableActionOrdinal = `managed-${input.processKind}`
      const familyKey = operationFamilyKey({
        executionLineageId: lineage.executionLineageId,
        slotPath,
        effectKind: 'process',
        stableActionOrdinal,
      })
      const operationGeneration = await input.persistence.nextOperationGeneration({
        executionLineageId: lineage.executionLineageId,
        operationFamilyKey: familyKey,
      })
      prepared = await waitForEffectResourceTurn(() =>
        input.persistence.prepareAndAcquire({
          token: context.token,
          intentId: context.intentId,
          operationKey: `${lineage.continuationSlotKey}:process:${input.processKind}`,
          executionLineageId: lineage.executionLineageId,
          operationFamilyKey: familyKey,
          operationGeneration,
          kind: 'process',
          requestHash: requestHash({
            v: 1,
            processKind: input.processKind,
            argv: input.argv,
            cwd: input.cwd,
          }),
          slotPathJson,
          slotPathDigest: sha256Hex(slotPathJson),
          candidateId: `${input.processKind}:${input.nodeRunId}`,
          recoveryClass: 'managed-process-preactivation',
          classifierVersion: 'rfc328-managed-process-v1',
          transportPolicyVersion: 'rfc328-preactivation-v1',
          retryAuthority: 'none',
          resourceKeys: [
            `process:${input.taskId}:${input.nodeRunId}`,
            ...(input.resourceKeys ?? []),
          ],
        }),
      )
    },
    async recordSpawnReceipt(receipt, runtimeParamsJson) {
      if (prepared === null) throw new Error('process spawn receipt preceded effect preparation')
      if (receipt.launchNonce === undefined || receipt.launchNonce.length === 0) {
        throw new Error('task-owned process spawn receipt lacks launch nonce')
      }
      await input.persistence.recordProcessSpawn({
        token: context.token,
        effectId: prepared.effectId,
        attemptId: prepared.attemptId,
        nodeRunId: input.nodeRunId,
        pid: receipt.pid,
        spawnBinaryPath: receipt.spawnBinaryPath,
        launchNonce: receipt.launchNonce,
        ...(runtimeParamsJson === undefined ? {} : { runtimeParamsJson }),
        now: Date.now(),
      })
    },
    async settle(result) {
      if (prepared === null) return
      const state: Exclude<TaskExecutionAttemptState, 'prepared' | 'acting' | 'outcome-unknown'> =
        result.outcome === 'child-unkillable' || result.outcome === 'unreaped'
          ? 'recovery-required'
          : result.outcome === 'spawn-failed'
            ? 'failed-not-applied'
            : 'succeeded'
      await input.persistence.settle({
        token: context.token,
        effectId: prepared.effectId,
        attemptId: prepared.attemptId,
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
