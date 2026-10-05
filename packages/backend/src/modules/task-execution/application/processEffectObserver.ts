// RFC-349 — provider-neutral managed-process effect coordinator.

import { sha256Hex } from '../domain/digest'
import { operationFamilyKey, type TaskExecutionAttemptState } from '../domain/executionEffect'
import {
  decodeLineageSlotPath,
  encodeLineageSlotPath,
  type LineageSlot,
} from '../domain/executionIntent'
import type { TaskExecutionEffectPersistence } from './ports/taskExecutionEffectStore'
import type { ProcessEffectOutcome, ProcessEffectProjection } from './ports/processEffectProjection'
import { currentTaskExecutionContext, type TaskExecutionContext } from './taskExecutionContext'
import { TaskExecutionError } from './taskExecutionError'
import { waitForEffectResourceTurn } from './effectResourceWait'

export interface ProcessEffectAttemptObserver<TReceipt, TResult extends ProcessEffectOutcome> {
  beforeSpawn(): Promise<void>
  recordSpawnReceipt(receipt: TReceipt, runtimeParamsJson?: string): Promise<void>
  settle(result: TResult): Promise<void>
}

export function createProcessEffectAttemptObserver<
  TReceipt,
  TResult extends ProcessEffectOutcome,
>(input: {
  persistence: TaskExecutionEffectPersistence
  taskId: string
  nodeRunId: string
  processKind: 'agent' | 'script'
  projection: ProcessEffectProjection<TReceipt, TResult>
  /** Explicit logical resolver consumed at the original acquisition point. */
  resourceKeys?: (
    description: ReturnType<ProcessEffectProjection<TReceipt, TResult>['describe']>,
  ) => readonly string[]
  context?: TaskExecutionContext
}): ProcessEffectAttemptObserver<TReceipt, TResult> | undefined {
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
      prepared = await waitForEffectResourceTurn(() => {
        const description = input.projection.describe()
        return input.persistence.prepareAndAcquire({
          token: context.token,
          intentId: context.intentId,
          operationKey: `${lineage.continuationSlotKey}:process:${input.processKind}`,
          executionLineageId: lineage.executionLineageId,
          operationFamilyKey: familyKey,
          operationGeneration,
          kind: 'process',
          requestHash: description.requestHash,
          slotPathJson,
          slotPathDigest: sha256Hex(slotPathJson),
          candidateId: `${input.processKind}:${input.nodeRunId}`,
          recoveryClass: description.recoveryClass,
          classifierVersion: description.classifierVersion,
          transportPolicyVersion: description.transportPolicyVersion,
          retryAuthority: 'none',
          resourceKeys: [
            `process:${input.taskId}:${input.nodeRunId}`,
            ...(input.resourceKeys?.(description) ?? description.resourceKeys),
          ],
        })
      })
    },
    async recordSpawnReceipt(receipt, runtimeParamsJson) {
      if (prepared === null) throw new Error('process spawn receipt preceded effect preparation')
      await input.projection.recordSpawnReceipt({
        token: context.token,
        effectId: prepared.effectId,
        attemptId: prepared.attemptId,
        nodeRunId: input.nodeRunId,
        receipt,
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
        receiptJson: input.projection.settlementReceipt(result),
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
