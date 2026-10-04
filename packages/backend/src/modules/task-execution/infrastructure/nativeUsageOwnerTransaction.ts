import { eq, max } from 'drizzle-orm'
import { AcceptedObservationInvocationSchema } from '@agent-workflow/shared'
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  nodeRuns,
  observationInvocations,
  taskExecutionIntents,
  taskExecutionObservationSources,
} from '@/db/schema'
import { databaseTransactionIsActive, engineOf } from '@/platform/persistence/databaseTransaction'
import { assertTaskExecutionContext } from '../application/taskExecutionContext'
import type { NativeUsageOwnerBinding } from '../application/ports/nativeUsagePersistence'
import {
  fenceTaskWrite,
  withTaskExecutionWrite,
  type TaskExecutionTransaction,
} from './ownedTaskExecution'

export interface NativeUsageOwnerFacts {
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
): Promise<T> {
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
    await fenceTaskWrite(tx, { taskId: binding.taskId, context: binding.executionContext })
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
      accepted.nativeCaptureContract !== 'opencode-child-pages-v2' ||
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
    return run(tx, facts)
  })
}

/** Actual original source row ID, including already projected rows; pending=0 is not an ACK. */
export async function nativeUsageSourceWatermark(
  tx: TaskExecutionTransaction,
  nodeRunId: string,
): Promise<string> {
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
