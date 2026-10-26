import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { insertOne } from '@/platform/persistence/singleInsert'
import { and, desc, eq } from 'drizzle-orm'
import type { TaskCreationParticipantInTx } from '../application/ports/taskCreation'
import {
  type TaskExecutionGenerationsParticipantInTx,
  TASK_EXECUTION_GENERATION_CAUSES,
} from '../application/ports/taskExecutionGenerations'

import { splitTaskCreation } from '../domain/taskCreation'
import { writeTaskWorkspaceDirectoriesInTx } from './taskWorkspaceDirectoryParticipant'

/** Caller owns the transaction; root, child and fusion share this one task writer. */
export function createTaskCreationParticipantInTx(tx: PersistenceDb): TaskCreationParticipantInTx {
  return {
    async create(input) {
      const tables = tablesOf(tx)
      const split = splitTaskCreation(input)
      await insertOne(tx, tables.tasks, split.task)
      await insertOne(tx, tables.taskDefinitions, split.definition)
      await insertOne(tx, tables.taskLaunchContexts, split.launchContext)
      await insertOne(tx, tables.taskWorkspaces, split.workspace)
      await insertOne(tx, tables.taskExecutionGenerations, split.generation)
      if (split.mounts.length)
        await tx.insert(tables.taskRepositoryMounts).values([...split.mounts])
      if (split.workgroupState) await insertOne(tx, tables.workgroupTaskState, split.workgroupState)
      await writeTaskWorkspaceDirectoriesInTx(
        tx,
        input.core.id,
        split.mounts.map((repo) => repo.mountPath ?? ''),
        input.nodePaths,
      )
      return split.lineage
    },
  }
}

export const taskExecutionGenerationsParticipant: TaskExecutionGenerationsParticipantInTx = {
  async openGeneration(tx, input) {
    const { taskExecutionGenerations: generations } = tablesOf(tx)
    if (!input.operationRef || !TASK_EXECUTION_GENERATION_CAUSES.includes(input.cause))
      throw new Error('task-generation-operation-invalid')
    const existing = (
      await tx
        .select()
        .from(generations)
        .where(
          and(
            eq(generations.taskId, input.taskId),
            eq(generations.operationRef, input.operationRef),
          ),
        )
    )[0]
    if (existing) {
      if (
        existing.cause !== input.cause ||
        existing.previousGenerationSeq !== input.previousGenerationSeq
      )
        throw new Error('task-generation-operation-conflict')
      return { ...existing, cause: input.cause }
    }
    const latest = (
      await tx
        .select()
        .from(generations)
        .where(eq(generations.taskId, input.taskId))
        .orderBy(desc(generations.generationSeq))
        .limit(1)
    )[0]
    if (!latest || latest.generationSeq !== input.previousGenerationSeq)
      throw new Error('task-generation-stale-predecessor')
    const row = { ...input, generationSeq: latest.generationSeq + 1 }
    await insertOne(tx, generations, row)
    return row
  },
}
