import { nativeUsageEvidenceStorage } from './nativeUsageEvidenceStorage'
import { eq, max } from 'drizzle-orm'
import { isDeepStrictEqual } from 'node:util'
import {
  AcceptedObservationInvocationSchema,
  ObservationNativeBeforeSpawnAckSchema,
} from '@agent-workflow/shared'
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  nodeRuns,
  observationInvocations,
  taskExecutionIntents,
  taskExecutionOwners,
  nativeUsagePreparations,
} from '@/db/schema'
import { databaseTransactionIsActive, engineOf } from '@/platform/persistence/databaseTransaction'
import { assertTaskExecutionContext } from '../application/taskExecutionContext'
import { TaskExecutionError } from '../application/taskExecutionError'
import { nativeUsageFinalizationReceipt } from './nativeUsageFinalizationAuthority'
import type { NativeUsageExecutionOwnerBinding as NativeUsageOwnerBinding } from '../application/ports/nativeUsagePersistence'
import {
  fenceTaskWrite,
  withTaskExecutionWrite,
  type TaskExecutionTransaction,
} from './ownedTaskExecution'
import { withSystemNativeUsageOwner } from './systemObservationOwner'

export interface NativeUsageOwnerFacts {
  readonly contract: 'opencode-child-pages-v2' | 'opencode-child-root-pages-v3'
  readonly nativeSource: string
  readonly lineage: string
  readonly epoch: string
  readonly fence: string
}

/** The original Task fence precedes the node lock, matching every original node writer. */
export async function withNativeUsageOwner<T>(
  db: ProviderNeutralDatabase,
  binding: NativeUsageOwnerBinding,
  run: (tx: TaskExecutionTransaction, facts: NativeUsageOwnerFacts) => Promise<T>,
  options: { readonly allowFinalization?: boolean } = {},
): Promise<T> {
  if (binding.sourceKind === 'system') return withSystemNativeUsageOwner(db, binding, run)
  assertTaskExecutionContext(binding.executionContext, binding.taskId)
  if (databaseTransactionIsActive(db))
    throw new Error('Native owner receipt requires its original transaction commit')
  return withTaskExecutionWrite(db, async (tx) => {
    const node = (
      await tx
        .select({ taskId: nodeRuns.taskId })
        .from(nodeRuns)
        .where(eq(nodeRuns.id, binding.nodeRunId))
        .limit(1)
    )[0]
    if (!node || node.taskId !== binding.taskId)
      throw new Error('Original native node owner is absent')
    let finalizationBefore: ReturnType<typeof nativeUsageFinalizationReceipt>
    let originalFenceError: TaskExecutionError | undefined
    try {
      await fenceTaskWrite(tx, { taskId: binding.taskId, context: binding.executionContext })
    } catch (error) {
      if (
        !(error instanceof TaskExecutionError) ||
        error.code !== 'task-execution-stale-owner' ||
        options.allowFinalization === false
      )
        throw error
      finalizationBefore = nativeUsageFinalizationReceipt(binding)
      if (!finalizationBefore) throw error
      // The same owner row stays locked before the original node lock. No Task claim is renewed.
      await engineOf(tx).lockAggregateRoot(
        tx,
        taskExecutionOwners,
        taskExecutionOwners.taskId,
        binding.taskId,
      )
      const owner = (
        await tx
          .select()
          .from(taskExecutionOwners)
          .where(eq(taskExecutionOwners.taskId, binding.taskId))
          .limit(1)
      )[0]
      const token = binding.executionContext.token
      if (
        !owner ||
        (owner.state !== 'revoked' && owner.state !== 'released') ||
        owner.taskId !== token.taskId ||
        owner.ownerId !== token.ownerId ||
        owner.daemonGeneration !== token.daemonGeneration ||
        owner.epoch !== token.epoch
      )
        throw error
      originalFenceError = error
    }
    await engineOf(tx).lockAggregateRoot(tx, nodeRuns, nodeRuns.id, binding.nodeRunId)
    const row = (
      await tx
        .select({ document: observationInvocations.document })
        .from(observationInvocations)
        .where(eq(observationInvocations.id, binding.invocationId))
        .limit(1)
    )[0]
    if (!row) throw new Error('Original native invocation was not accepted')
    const accepted = AcceptedObservationInvocationSchema.parse(JSON.parse(row.document))
    if (
      accepted.taskId !== binding.taskId ||
      accepted.nodeRunId !== binding.nodeRunId ||
      accepted.authority.kind !== 'local' ||
      (accepted.nativeCaptureContract !== 'opencode-child-pages-v2' &&
        accepted.nativeCaptureContract !== 'opencode-child-root-pages-v3') ||
      !accepted.nativeCaptureSource
    )
      throw new Error('Original native invocation binding changed')
    const intent = (
      await tx
        .select({
          taskId: taskExecutionIntents.taskId,
          lineage: taskExecutionIntents.executionLineageId,
        })
        .from(taskExecutionIntents)
        .where(eq(taskExecutionIntents.id, binding.executionContext.intentId))
        .limit(1)
    )[0]
    if (!intent || intent.taskId !== binding.taskId)
      throw new Error('Original native claim intent changed')
    const token = binding.executionContext.token
    const facts: NativeUsageOwnerFacts = {
      contract: accepted.nativeCaptureContract,
      nativeSource: accepted.nativeCaptureSource,
      lineage: intent.lineage,
      epoch: String(token.epoch),
      // Heartbeat revision and lease advance independently; the original claim tuple is stable.
      fence: JSON.stringify([
        binding.executionContext.intentId,
        token.taskId,
        token.ownerId,
        token.daemonGeneration,
        token.epoch,
      ]),
    }
    if (finalizationBefore) {
      const prepared = (
        await tx
          .select()
          .from(nativeUsagePreparations)
          .where(eq(nativeUsagePreparations.invocationId, binding.invocationId))
          .limit(1)
      )[0]
      if (
        facts.contract !== 'opencode-child-root-pages-v3' ||
        !prepared ||
        prepared.taskId !== binding.taskId ||
        prepared.nodeRunId !== binding.nodeRunId ||
        prepared.fence !== facts.fence ||
        prepared.ownerReceiptId !== finalizationBefore.ownerReceiptId ||
        finalizationBefore.nativeSource !== facts.nativeSource ||
        finalizationBefore.lineage !== facts.lineage ||
        finalizationBefore.epoch !== facts.epoch ||
        !isDeepStrictEqual(
          ObservationNativeBeforeSpawnAckSchema.parse(JSON.parse(prepared.document)),
          finalizationBefore,
        )
      )
        throw originalFenceError
    }
    return run(tx, facts)
  })
}

/** Actual original source row ID, including already projected rows; pending=0 is not an ACK. */
export async function nativeUsageSourceWatermark(
  tx: TaskExecutionTransaction,
  nodeRunId: string,
  sourceKind: 'task' | 'system' = 'task',
): Promise<string> {
  const { taskExecutionObservationSources } = nativeUsageEvidenceStorage(sourceKind)

  const row = (
    await tx
      .select({ id: max(taskExecutionObservationSources.id) })
      .from(taskExecutionObservationSources)
      .where(eq(taskExecutionObservationSources.nodeRunId, nodeRunId))
  )[0]
  const value = row?.id ?? 0
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error('Original native source watermark is not exact')
  return String(value)
}
