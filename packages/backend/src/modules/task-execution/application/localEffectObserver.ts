// RFC-349 — provider-neutral local filesystem/Git effect coordinator.

import { sha256Hex } from '../domain/digest'
import { operationFamilyKey, requestHash } from '../domain/executionEffect'
import {
  decodeLineageSlotPath,
  encodeLineageSlotPath,
  type LineageSlot,
} from '../domain/executionIntent'
import type { TaskExecutionEffectPersistence } from './ports/taskExecutionEffectStore'
import type { WorkspacePreparationSettlementProjection } from './ports/taskExecutionEffectStore'
import { currentTaskExecutionContext, type TaskExecutionContext } from './taskExecutionContext'
import { TaskExecutionError } from './taskExecutionError'
import { waitForEffectResourceTurn } from './effectResourceWait'

export type LocalTaskExecutionEffectKind =
  | 'workspace-prepare'
  | 'workspace-rollback'
  | 'isolation-create'
  | 'isolation-merge'
  | 'repository'
  | 'workspace-cleanup'

export interface LocalEffectAttemptObserver {
  beforeAct(): Promise<void>
  retry(error: unknown, authority: 'convergent' | 'transport-policy'): Promise<void>
  succeed(receipt?: Readonly<Record<string, unknown>>): Promise<void>
  succeedWorkspacePreparation(
    receipt: Readonly<Record<string, unknown>>,
    projection: WorkspacePreparationSettlementProjection,
  ): Promise<void>
  fail(error: unknown, receipt?: Readonly<Record<string, unknown>>): Promise<void>
}

export function createLocalEffectAttemptObserver(input: {
  persistence: TaskExecutionEffectPersistence
  taskId: string
  nodeRunId?: string
  kind: LocalTaskExecutionEffectKind
  stableActionOrdinal: string
  candidateId: string
  request: unknown
  resourceKeys: readonly string[]
  context?: TaskExecutionContext
}): LocalEffectAttemptObserver | undefined {
  const context = input.context ?? currentTaskExecutionContext(input.taskId)
  if (context === undefined) return undefined
  let prepared: { readonly effectId: string; readonly attemptId: string } | null = null
  let settled = false
  let nextRetryAuthority: 'none' | 'convergent' | 'transport-policy' = 'none'

  const settle = async (args: {
    readonly state: 'succeeded' | 'retry-authorized' | 'recovery-required'
    readonly applicationEvidence: 'applied' | 'ambiguous'
    readonly receipt: Readonly<Record<string, unknown>>
    readonly failureCode?: string
    readonly retryAuthority?: 'none' | 'convergent' | 'transport-policy'
    readonly workspacePreparation?: WorkspacePreparationSettlementProjection
  }) => {
    if (prepared === null) throw new Error(`${input.kind} effect settled before preparation`)
    if (settled) throw new Error(`${input.kind} effect settled twice`)
    const settlement = {
      token: context.token,
      effectId: prepared.effectId,
      attemptId: prepared.attemptId,
      state: args.state,
      applicationEvidence: args.applicationEvidence,
      retryAuthority: args.retryAuthority ?? 'none',
      receiptJson: JSON.stringify({ v: 1, ...args.receipt }),
      ...(args.failureCode === undefined ? {} : { failureCode: args.failureCode }),
      now: Date.now(),
    } as const
    if (args.workspacePreparation === undefined) {
      await input.persistence.settle(settlement)
    } else {
      await input.persistence.settleWorkspacePreparation({
        settlement,
        projection: args.workspacePreparation,
      })
    }
    settled = true
  }

  return {
    async beforeAct() {
      if (prepared !== null) throw new Error(`${input.kind} effect prepared twice`)
      const lineage = await input.persistence.readLineage({
        taskId: input.taskId,
        intentId: context.intentId,
        ...(input.nodeRunId === undefined ? {} : { nodeRunId: input.nodeRunId }),
      })
      if (lineage === null) {
        throw new TaskExecutionError(
          'task-continuation-stale',
          `cannot prepare ${input.kind} effect for missing task/intent '${input.taskId}/${context.intentId}'`,
        )
      }
      const fallbackPath: readonly LineageSlot[] = [
        {
          stableNodeKey: 'task-root',
          frozenOccurrenceKey: lineage.executionLineageId,
          workflowRevision: lineage.workflowVersion,
        },
        ...(lineage.nodeId === null
          ? []
          : [
              {
                stableNodeKey: lineage.nodeId,
                frozenOccurrenceKey:
                  lineage.continuationSlotKey ||
                  `${lineage.nodeId}:${lineage.iteration ?? 0}:${lineage.shardKey ?? ''}:${lineage.retryIndex ?? 0}`,
                workflowRevision: lineage.workflowVersion,
              },
            ]),
      ]
      let slotPath = fallbackPath
      try {
        slotPath = decodeLineageSlotPath(lineage.slotPathJson)
      } catch {
        // Imported legacy rows use the deterministic fallback.
      }
      const slotPathJson = encodeLineageSlotPath(slotPath)
      const familyKey = operationFamilyKey({
        executionLineageId: lineage.executionLineageId,
        slotPath,
        effectKind: input.kind,
        stableActionOrdinal: input.stableActionOrdinal,
      })
      const operationGeneration = await input.persistence.nextOperationGeneration({
        executionLineageId: lineage.executionLineageId,
        operationFamilyKey: familyKey,
      })
      const next = await waitForEffectResourceTurn(() =>
        input.persistence.prepareAndAcquire({
          token: context.token,
          intentId: context.intentId,
          operationKey: `${lineage.continuationSlotKey}:${input.kind}:${input.stableActionOrdinal}`,
          executionLineageId: lineage.executionLineageId,
          operationFamilyKey: familyKey,
          operationGeneration,
          kind: input.kind,
          requestHash: requestHash(input.request),
          slotPathJson,
          slotPathDigest: sha256Hex(slotPathJson),
          candidateId: input.candidateId,
          recoveryClass: 'local-probe-or-actor',
          classifierVersion: 'rfc328-local-effect-v1',
          transportPolicyVersion: 'rfc328-local-effect-direct-v1',
          retryAuthority: nextRetryAuthority,
          resourceKeys: input.resourceKeys,
        }),
      )
      prepared = next
      settled = false
      nextRetryAuthority = 'none'
    },
    async retry(error, authority) {
      await settle({
        state: 'retry-authorized',
        applicationEvidence: 'ambiguous',
        retryAuthority: authority,
        failureCode: 'local-effect-retry-authorized',
        receipt: {
          error: (error instanceof Error ? error.message : String(error)).slice(0, 2_000),
        },
      })
      prepared = null
      settled = false
      nextRetryAuthority = authority
      await this.beforeAct()
    },
    async succeed(receipt = {}) {
      await settle({ state: 'succeeded', applicationEvidence: 'applied', receipt })
    },
    async succeedWorkspacePreparation(receipt, projection) {
      await settle({
        state: 'succeeded',
        applicationEvidence: 'applied',
        receipt,
        workspacePreparation: projection,
      })
    },
    async fail(error, receipt = {}) {
      await settle({
        state: 'recovery-required',
        applicationEvidence: 'ambiguous',
        failureCode: 'local-effect-threw',
        receipt: {
          ...receipt,
          error: (error instanceof Error ? error.message : String(error)).slice(0, 2_000),
        },
      })
    },
  }
}

export async function runTaskLocalEffect<T>(
  input: Parameters<typeof createLocalEffectAttemptObserver>[0] & {
    act: () => Promise<T>
    receipt?: (result: T) => Readonly<Record<string, unknown>>
  },
): Promise<T> {
  const observer = createLocalEffectAttemptObserver(input)
  await observer?.beforeAct()
  try {
    const result = await input.act()
    await observer?.succeed(input.receipt?.(result) ?? {})
    return result
  } catch (error) {
    await observer?.fail(error)
    throw error
  }
}
