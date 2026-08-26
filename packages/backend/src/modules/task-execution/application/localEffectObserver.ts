// RFC-328 — task-owned filesystem/Git logical-effect coordinator.

import { and, eq } from '@/db/query'
import { sha256Hex } from '../domain/digest'
import type { DbClient } from '@/db/client'
import type { DbTxSync } from '@/db/txSync'
import { nodeRuns, taskExecutionIntents, tasks } from '@/db/schema'
import { taskExecutionModule } from '../composition'
import { operationFamilyKey, requestHash } from '../domain/executionEffect'
import {
  decodeLineageSlotPath,
  encodeLineageSlotPath,
  type LineageSlot,
} from '../domain/executionIntent'
import { currentTaskExecutionContext, type TaskExecutionContext } from './taskExecutionContext'
import { TaskExecutionError } from './taskExecutionError'
import { waitForEffectResourceTurn } from './effectResourceWait'

const LOCAL_EFFECT_CLASSIFIER_VERSION = 'rfc328-local-effect-v1'
const LOCAL_EFFECT_TRANSPORT_VERSION = 'rfc328-local-effect-direct-v1'

export type LocalTaskExecutionEffectKind =
  | 'workspace-prepare'
  | 'workspace-rollback'
  | 'isolation-create'
  | 'isolation-merge'
  | 'repository'
  | 'workspace-cleanup'

function sha256(value: string): string {
  return sha256Hex(value)
}

export interface LocalEffectAttemptObserver {
  beforeAct(): Promise<void>
  retry(error: unknown, authority: 'convergent' | 'transport-policy'): Promise<void>
  succeed(receipt?: Readonly<Record<string, unknown>>, onSettledTx?: (tx: DbTxSync) => void): void
  fail(error: unknown, receipt?: Readonly<Record<string, unknown>>): void
}

/**
 * Every real local act is journalled before invocation. A thrown local
 * filesystem/Git operation is conservatively left recovery-required because
 * those APIs may mutate before returning an error; the task-wide quiescence
 * closure converts it to outcome-unknown while keeping manual retry at N+1.
 */
export function createLocalEffectAttemptObserver(input: {
  db: DbClient
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

  const task = input.db
    .select({
      executionLineageId: tasks.executionLineageId,
      lineageSlotPathJson: tasks.lineageSlotPathJson,
      workflowVersion: tasks.workflowVersion,
    })
    .from(tasks)
    .where(eq(tasks.id, input.taskId))
    .get()
  const intent = input.db
    .select({
      executionLineageId: taskExecutionIntents.executionLineageId,
      continuationSlotKey: taskExecutionIntents.continuationSlotKey,
      slotPathJson: taskExecutionIntents.slotPathJson,
    })
    .from(taskExecutionIntents)
    .where(eq(taskExecutionIntents.id, context.intentId))
    .get()
  const run =
    input.nodeRunId === undefined
      ? undefined
      : input.db
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
  if (task === undefined || intent === undefined) {
    throw new TaskExecutionError(
      'task-continuation-stale',
      `cannot prepare ${input.kind} effect for missing task/intent '${input.taskId}/${context.intentId}'`,
    )
  }

  const executionLineageId = task.executionLineageId ?? intent.executionLineageId
  const fallbackPath: readonly LineageSlot[] = [
    {
      stableNodeKey: 'task-root',
      frozenOccurrenceKey: executionLineageId,
      workflowRevision: task.workflowVersion,
    },
    ...(run === undefined
      ? []
      : [
          {
            stableNodeKey: run.nodeId,
            frozenOccurrenceKey:
              run.continuationSlotKey ??
              `${run.nodeId}:${run.iteration}:${run.shardKey ?? ''}:${run.retryIndex}`,
            workflowRevision: task.workflowVersion,
          },
        ]),
  ]
  let slotPath = fallbackPath
  for (const encoded of [run?.lineageSlotPathJson, intent.slotPathJson, task.lineageSlotPathJson]) {
    if (encoded === undefined || encoded === null) continue
    try {
      slotPath = decodeLineageSlotPath(encoded)
      break
    } catch {
      // Imported legacy rows use the deterministic fallback above.
    }
  }
  const slotPathJson = encodeLineageSlotPath(slotPath)
  const slotPathDigest = sha256(slotPathJson)
  const continuationSlotKey = run?.continuationSlotKey ?? intent.continuationSlotKey
  const familyKey = operationFamilyKey({
    executionLineageId,
    slotPath,
    effectKind: input.kind,
    stableActionOrdinal: input.stableActionOrdinal,
  })
  const operationKey = `${continuationSlotKey}:${input.kind}:${input.stableActionOrdinal}`
  let prepared: { effectId: string; attemptId: string } | null = null
  let settled = false

  const settle = (args: {
    state: 'succeeded' | 'retry-authorized' | 'recovery-required'
    applicationEvidence: 'applied' | 'ambiguous'
    receipt: Readonly<Record<string, unknown>>
    failureCode?: string
    retryAuthority?: 'none' | 'convergent' | 'transport-policy'
    onSettledTx?: (tx: DbTxSync) => void
  }): void => {
    if (prepared === null) throw new Error(`${input.kind} effect settled before preparation`)
    if (settled) throw new Error(`${input.kind} effect settled twice`)
    taskExecutionModule.effects.settle({
      db: input.db,
      token: context.token,
      effectId: prepared.effectId,
      attemptId: prepared.attemptId,
      state: args.state,
      applicationEvidence: args.applicationEvidence,
      retryAuthority: args.retryAuthority ?? 'none',
      receiptJson: JSON.stringify({ v: 1, ...args.receipt }),
      ...(args.failureCode !== undefined ? { failureCode: args.failureCode } : {}),
      ...(args.onSettledTx !== undefined ? { onSettledTx: args.onSettledTx } : {}),
      now: Date.now(),
    })
    settled = true
  }

  let nextRetryAuthority: 'none' | 'convergent' | 'transport-policy' = 'none'

  return {
    async beforeAct() {
      if (prepared !== null) throw new Error(`${input.kind} effect prepared twice`)
      const next = await waitForEffectResourceTurn(() =>
        taskExecutionModule.effects.prepareAndAcquire({
          db: input.db,
          token: context.token,
          intentId: context.intentId,
          operationKey,
          executionLineageId,
          operationFamilyKey: familyKey,
          // Generation is scoped to the operation family, not to the task's
          // continuation count. A family first encountered during resume #1 is
          // still generation 0; a replay of an existing family advances from
          // its live/retained watermark even after child-row deletion.
          operationGeneration: taskExecutionModule.effects.nextOperationGeneration({
            db: input.db,
            executionLineageId,
            operationFamilyKey: familyKey,
          }),
          kind: input.kind,
          requestHash: requestHash(input.request),
          slotPathJson,
          slotPathDigest,
          candidateId: input.candidateId,
          recoveryClass: 'local-probe-or-actor',
          classifierVersion: LOCAL_EFFECT_CLASSIFIER_VERSION,
          transportPolicyVersion: LOCAL_EFFECT_TRANSPORT_VERSION,
          retryAuthority: nextRetryAuthority,
          resourceKeys: input.resourceKeys,
        }),
      )
      prepared = { effectId: next.effectId, attemptId: next.attemptId }
      nextRetryAuthority = 'none'
    },

    async retry(error, authority) {
      const message = error instanceof Error ? error.message : String(error)
      settle({
        state: 'retry-authorized',
        applicationEvidence: 'ambiguous',
        retryAuthority: authority,
        failureCode: 'local-effect-retry-authorized',
        receipt: { error: message.slice(0, 2_000) },
      })
      prepared = null
      settled = false
      nextRetryAuthority = authority
      await this.beforeAct()
    },

    succeed(receipt = {}, onSettledTx) {
      settle({
        state: 'succeeded',
        applicationEvidence: 'applied',
        receipt,
        ...(onSettledTx !== undefined ? { onSettledTx } : {}),
      })
    },

    fail(error, receipt = {}) {
      const message = error instanceof Error ? error.message : String(error)
      settle({
        state: 'recovery-required',
        applicationEvidence: 'ambiguous',
        failureCode: 'local-effect-threw',
        receipt: { ...receipt, error: message.slice(0, 2_000) },
      })
    },
  }
}

export async function runTaskLocalEffect<T>(input: {
  db: DbClient
  taskId: string
  nodeRunId?: string
  kind: LocalTaskExecutionEffectKind
  stableActionOrdinal: string
  candidateId: string
  request: unknown
  resourceKeys: readonly string[]
  context?: TaskExecutionContext
  act: () => Promise<T>
  receipt?: (result: T) => Readonly<Record<string, unknown>>
}): Promise<T> {
  const observer = createLocalEffectAttemptObserver(input)
  await observer?.beforeAct()
  try {
    const result = await input.act()
    observer?.succeed(input.receipt?.(result) ?? {})
    return result
  } catch (error) {
    observer?.fail(error)
    throw error
  }
}
