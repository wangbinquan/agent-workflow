import { taskWorkgroupRuntimeRevisionMatches } from './taskWorkgroupConfig'
import { taskWorkspaceRootMatchesSql } from './taskRepositorySql'
import { and, eq, isNull, sql } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { queryRows } from '@/platform/persistence/queryHelpers'
import type { TaskDefinitionWritePort } from '../application/ports/taskDefinitionWrite'

/** II-a keeps each original single-row CAS and the caller-owned transaction. */
export function createTaskDefinitionWriteParticipantInTx(
  tx: PersistenceDb,
): TaskDefinitionWritePort {
  const { tasks } = tablesOf(tx)
  return {
    async syncWorkflow(input) {
      const [changed] = await tx
        .update(tasks)
        .set({
          status: 'interrupted',
          workflowSnapshot: input.snapshot,
          workflowVersion: input.sourceRevision,
          refClosureJson: input.resourceClosure,
          finishedAt: input.occurredAt,
          lifecycleEventRevision: sql`${tasks.lifecycleEventRevision} + 1`,
        })
        .where(
          and(
            eq(tasks.id, input.taskId),
            eq(tasks.status, input.expectedStatus),
            eq(tasks.lifecycleEventRevision, input.expectedLifecycleRevision),
            isNull(tasks.workspacePrunedAt),
          ),
        )
        .returning({ revision: tasks.lifecycleEventRevision })
      return changed?.revision ?? null
    },
    async replaceWorkgroupRuntimeConfig(input) {
      const [changed] = await tx
        .update(tasks)
        .set({ workgroupConfigJson: input.nextConfig })
        .where(
          and(
            eq(tasks.id, input.taskId),
            taskWorkgroupRuntimeRevisionMatches(tx, input.expectedRevision),
          ),
        )
        .returning({ id: tasks.id })
      return changed !== undefined
    },
    async continueWorkgroupTask(input) {
      const [changed] = await tx
        .update(tasks)
        .set({
          status: 'pending',
          finishedAt: null,
          errorSummary: null,
          errorMessage: null,
          failedNodeId: null,
          lifecycleEventRevision: input.expectedLifecycleRevision + 1,
          ...(input.snapshot === undefined ? {} : { workflowSnapshot: input.snapshot }),
        })
        .where(
          and(
            eq(tasks.id, input.taskId),
            eq(tasks.status, input.expectedStatus),
            eq(tasks.lifecycleEventRevision, input.expectedLifecycleRevision),
          ),
        )
        .returning({ id: tasks.id })
      return changed !== undefined
    },
    transitionLifecycle(input) {
      const prune = input.workspacePruneDecision
      // rfc097-allow-direct-task-status-write -- existing lifecycle CAS moved intact
      return queryRows(
        tx
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
            ...(input.extra ?? {}),
            ...(prune.prune
              ? { workspacePruningAt: input.now, workspacePruneCause: prune.cause }
              : {}),
            lifecycleEventRevision: sql`${tasks.lifecycleEventRevision} + 1`,
          })
          .where(
            and(
              eq(tasks.id, input.taskId),
              eq(tasks.status, input.from),
              ...(input.expectedLifecycleRevision === undefined
                ? []
                : [eq(tasks.lifecycleEventRevision, input.expectedLifecycleRevision)]),
              ...(input.expectedWorktreePath === undefined
                ? []
                : [taskWorkspaceRootMatchesSql(tasks.worktreePath, input.expectedWorktreePath)]),
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
            ),
          )
          .returning({ id: tasks.id, lifecycleEventRevision: tasks.lifecycleEventRevision }),
      )
    },
  }
}
