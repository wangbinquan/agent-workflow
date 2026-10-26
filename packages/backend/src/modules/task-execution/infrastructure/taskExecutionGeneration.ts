import { and, desc, eq } from 'drizzle-orm'
import type { PersistenceTx } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { first } from '@/platform/persistence/queryHelpers'
import type { NodeRunMintGeneration } from '../application/nodeRunMintIdentity'
import { taskExecutionGenerationsParticipant } from './taskCreationParticipant'

/** Caller holds the owner fence when applicable and the task root before any run write. */
export async function resolveTaskExecutionGenerationInTx(
  tx: PersistenceTx,
  taskId: string,
  request: NodeRunMintGeneration,
) {
  const { taskExecutionGenerations: generations } = tablesOf(tx)
  if (request.kind === 'existing') {
    const row = await first(
      tx
        .select()
        .from(generations)
        .where(
          and(eq(generations.taskId, taskId), eq(generations.generationSeq, request.generationSeq)),
        ),
    )
    if (!row) throw new Error('node-run-generation-missing')
    return row.generationSeq
  }
  if (request.kind === 'operation') {
    const replay = await first(
      tx
        .select()
        .from(generations)
        .where(
          and(eq(generations.taskId, taskId), eq(generations.operationRef, request.operationRef)),
        ),
    )
    if (replay) {
      if (replay.cause !== request.cause) throw new Error('task-generation-operation-conflict')
      return replay.generationSeq
    }
  }
  const current = await first(
    tx
      .select()
      .from(generations)
      .where(eq(generations.taskId, taskId))
      .orderBy(desc(generations.generationSeq))
      .limit(1),
  )
  if (!current) throw new Error('node-run-generation-missing')
  if (request.kind === 'current') return current.generationSeq
  return (
    await taskExecutionGenerationsParticipant.openGeneration(tx, {
      taskId,
      cause: request.cause,
      operationRef: request.operationRef,
      previousGenerationSeq: current.generationSeq,
      createdAt: Date.now(),
    })
  ).generationSeq
}
