import { resolveTaskExecutionGenerationInTx } from './taskExecutionGeneration'
import { engineOf } from '@/platform/persistence/databaseTransaction'
import type { PersistenceDb, PersistenceTx } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { and, eq, isNull, sql, type SQL } from 'drizzle-orm'
import type { TaskAggregateWritePort } from '../application/ports/taskAggregateWrite'
import type {
  TaskDefinitionWritePort,
  TaskLifecycleWriteExtra,
} from '../application/ports/taskDefinitionWrite'
import { taskWorkspaceRootMatchesSql } from './taskRepositorySql'

export const taskAggregateWrite: TaskAggregateWritePort = {
  async lockTaskAggregateRoot(tx, taskId) {
    const { tasks } = tablesOf(tx)
    await engineOf(tx).lockAggregateRoot(tx, tasks, tasks.id, taskId)
  },
}

export class TaskAggregateCasMiss extends Error {
  constructor(taskId: string) {
    super(`task-aggregate-cas-miss:${taskId}`)
  }
}

/** Lock all roots before reading or writing any owned row. */
export async function lockTaskAggregateRoots(
  tx: PersistenceTx,
  taskIds: readonly string[],
): Promise<void> {
  for (const taskId of [...new Set(taskIds)].sort())
    await taskAggregateWrite.lockTaskAggregateRoot(tx, taskId)
}

async function matches(tx: PersistenceTx, predicate: SQL | undefined): Promise<boolean> {
  const { tasks } = tablesOf(tx)
  return (await tx.select({ id: tasks.id }).from(tasks).where(predicate).limit(1)).length !== 0
}

/** Caller holds the root lock and must throw on a missed final lifecycle CAS. */
export async function writeTaskDefinitionPatchInTx(
  tx: PersistenceTx,
  taskId: string,
  extra: TaskLifecycleWriteExtra,
) {
  const { taskDefinitions, workgroupTaskState } = tablesOf(tx)
  const { workflowSnapshot, workflowVersion, refClosureJson, workgroupConfigJson, ...root } = extra
  if (
    workflowSnapshot !== undefined ||
    workflowVersion !== undefined ||
    refClosureJson !== undefined
  ) {
    const definition = await tx
      .update(taskDefinitions)
      .set({
        ...(workflowSnapshot === undefined ? {} : { workflowSnapshot }),
        ...(workflowVersion === undefined ? {} : { sourceRevision: workflowVersion }),
        ...(refClosureJson === undefined ? {} : { refClosureJson }),
        definitionRevision: sql`${taskDefinitions.definitionRevision} + 1`,
      })
      .where(eq(taskDefinitions.taskId, taskId))
      .returning({ taskId: taskDefinitions.taskId })
    if (definition.length !== 1) throw new TaskAggregateCasMiss(taskId)
  }
  if (workgroupConfigJson !== undefined) {
    const state = await tx
      .update(workgroupTaskState)
      .set({
        runtimeConfigJson: workgroupConfigJson,
        configRevision: sql`${workgroupTaskState.configRevision} + 1`,
      })
      .where(eq(workgroupTaskState.taskId, taskId))
      .returning({ taskId: workgroupTaskState.taskId })
    if (state.length !== 1) throw new TaskAggregateCasMiss(taskId)
  }
  return root
}

/** Subordinate writes precede the final CAS; a miss aborts the caller's transaction. */
export function createTaskDefinitionWriteParticipantInTx(
  tx: PersistenceDb,
): TaskDefinitionWritePort {
  const { tasks, workgroupTaskState } = tablesOf(tx)
  return {
    async syncWorkflow(input) {
      await taskAggregateWrite.lockTaskAggregateRoot(tx, input.taskId)
      const predicate = and(
        eq(tasks.id, input.taskId),
        eq(tasks.status, input.expectedStatus),
        eq(tasks.lifecycleEventRevision, input.expectedLifecycleRevision),
        isNull(tasks.workspacePrunedAt),
      )
      if (!(await matches(tx, predicate))) return null
      await resolveTaskExecutionGenerationInTx(tx, input.taskId, {
        kind: 'operation',
        cause: 'workflow-sync',
        operationRef: `workflow-sync:${input.taskId}:${input.expectedLifecycleRevision}:${input.sourceRevision}`,
      })
      await writeTaskDefinitionPatchInTx(tx, input.taskId, {
        workflowSnapshot: input.snapshot,
        workflowVersion: input.sourceRevision,
        refClosureJson: input.resourceClosure,
      })
      // rfc097-allow-direct-task-status-write -- existing lifecycle CAS, after definition writes
      const [changed] = await tx
        .update(tasks)
        .set({
          status: 'interrupted',
          finishedAt: input.occurredAt,
          lifecycleEventRevision: sql`${tasks.lifecycleEventRevision} + 1`,
        })
        .where(predicate)
        .returning({ revision: tasks.lifecycleEventRevision })
      if (!changed) throw new TaskAggregateCasMiss(input.taskId)
      return changed.revision
    },
    async replaceWorkgroupRuntimeConfig(input) {
      await taskAggregateWrite.lockTaskAggregateRoot(tx, input.taskId)
      const predicate = and(
        eq(tasks.id, input.taskId),
        sql`exists (select 1 from ${workgroupTaskState}
        where ${workgroupTaskState.taskId} = ${tasks.id} and ${workgroupTaskState.runtimeConfigJson} = ${input.expectedRevision})`,
      )
      if (!(await matches(tx, predicate))) return false
      await writeTaskDefinitionPatchInTx(tx, input.taskId, {
        workgroupConfigJson: input.nextConfig,
      })
      // The root lock serializes the runtime-config revision comparison above;
      // a config edit does not advance the task lifecycle revision.
      return true
    },
    async continueWorkgroupTask(input) {
      await taskAggregateWrite.lockTaskAggregateRoot(tx, input.taskId)
      const predicate = and(
        eq(tasks.id, input.taskId),
        eq(tasks.status, input.expectedStatus),
        eq(tasks.lifecycleEventRevision, input.expectedLifecycleRevision),
      )
      if (!(await matches(tx, predicate))) return false
      if (input.snapshot !== undefined)
        await resolveTaskExecutionGenerationInTx(tx, input.taskId, {
          kind: 'operation',
          cause: 'dynamic-workflow-approval',
          operationRef: `dynamic-workflow-approval:${input.taskId}:${input.expectedLifecycleRevision}`,
        })
      if (input.snapshot !== undefined)
        await writeTaskDefinitionPatchInTx(tx, input.taskId, { workflowSnapshot: input.snapshot })
      // rfc097-allow-direct-task-status-write -- original revival CAS
      const [changed] = await tx
        .update(tasks)
        .set({
          status: 'pending',
          finishedAt: null,
          errorSummary: null,
          errorMessage: null,
          failedNodeId: null,
          lifecycleEventRevision: input.expectedLifecycleRevision + 1,
        })
        .where(predicate)
        .returning({ id: tasks.id })
      if (!changed) throw new TaskAggregateCasMiss(input.taskId)
      return true
    },
    async transitionLifecycle(input) {
      const prune = input.workspacePruneDecision
      await taskAggregateWrite.lockTaskAggregateRoot(tx, input.taskId)
      const predicate = and(
        eq(tasks.id, input.taskId),
        eq(tasks.status, input.from),
        ...(input.expectedLifecycleRevision === undefined
          ? []
          : [eq(tasks.lifecycleEventRevision, input.expectedLifecycleRevision)]),
        ...(input.expectedWorktreePath === undefined
          ? []
          : [taskWorkspaceRootMatchesSql(tasks.workspaceRootRef, input.expectedWorktreePath)]),
        ...(input.isRevival
          ? [
              isNull(tasks.deletedAt),
              isNull(tasks.sourceTerminationFence),
              isNull(tasks.workspacePruningAt),
              isNull(tasks.workspacePrunedAt),
            ]
          : []),
        ...(prune.prune
          ? [
              isNull(tasks.workspacePruningAt),
              isNull(tasks.workspacePruneCause),
              isNull(tasks.workspacePrunedAt),
            ]
          : []),
      )
      if (!(await matches(tx, predicate))) return []
      const extra = await writeTaskDefinitionPatchInTx(tx, input.taskId, input.extra ?? {})
      // rfc097-allow-direct-task-status-write -- preserves the original lifecycle predicate
      const changed = await tx
        .update(tasks)
        .set({
          status: input.to,
          ...(input.to === 'running'
            ? { runningSince: input.now }
            : input.from === 'running'
              ? {
                  runningMs: sql`${tasks.runningMs} + (${input.now} - COALESCE(${tasks.runningSince}, ${input.now}))`,
                  runningSince: null,
                }
              : {}),
          ...extra,
          ...(prune.prune
            ? { workspacePruningAt: input.now, workspacePruneCause: prune.cause }
            : {}),
          lifecycleEventRevision: sql`${tasks.lifecycleEventRevision} + 1`,
        })
        .where(predicate)
        .returning({ id: tasks.id, lifecycleEventRevision: tasks.lifecycleEventRevision })
      if (changed.length === 0) throw new TaskAggregateCasMiss(input.taskId)
      return changed
    },
  }
}
