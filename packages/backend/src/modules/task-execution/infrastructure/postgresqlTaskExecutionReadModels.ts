// RFC-349 — PostgreSQL implementation of the provider-neutral task-execution
// read models. Consumers keep the same Promise contracts and never receive a
// provider client; bootstrap selects this adapter for a PostgreSQL generation.

import { asc, eq } from 'drizzle-orm'

import { docVersions, taskRepos, tasks } from '@/db/schema'
import type {
  ReviewGateSubjectReadModel,
  TaskCallGraphWorkspaceReadModel,
  TaskExecutionReadModels,
  TaskReviewNodeCatalogReadModel,
  TaskStatusProjectionReadModel,
} from '@/modules/task-execution/public/types'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'

export function createPostgresqlTaskExecutionReadModels(
  db: PostgresqlDatabaseClient,
): TaskExecutionReadModels {
  const statusProjection: TaskStatusProjectionReadModel = {
    async find(taskId) {
      const rows = await db
        .select({
          taskId: tasks.id,
          status: tasks.status,
          errorSummary: tasks.errorSummary,
        })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .limit(1)
      return rows[0] ?? null
    },
  }

  const callGraphWorkspace: TaskCallGraphWorkspaceReadModel = {
    async find(taskId) {
      const taskRows = await db
        .select({ taskId: tasks.id, worktreePath: tasks.worktreePath })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .limit(1)
      const task = taskRows[0]
      if (task === undefined) return null

      const repoRows = await db
        .select({
          worktreeDirName: taskRepos.worktreeDirName,
          worktreePath: taskRepos.worktreePath,
        })
        .from(taskRepos)
        .where(eq(taskRepos.taskId, taskId))
        .orderBy(asc(taskRepos.repoIndex))

      return {
        taskId: task.taskId,
        worktreePath: task.worktreePath,
        repos:
          repoRows.length > 0
            ? repoRows
            : [{ worktreeDirName: '', worktreePath: task.worktreePath }],
      }
    },
  }

  const taskReviewNodes: TaskReviewNodeCatalogReadModel = {
    async find(taskId) {
      const rows = await db
        .select({
          taskId: tasks.id,
          taskOwnerUserId: tasks.ownerUserId,
          workflowSnapshot: tasks.workflowSnapshot,
        })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .limit(1)
      const row = rows[0]
      if (row === undefined) return null
      try {
        const parsed = JSON.parse(row.workflowSnapshot) as {
          nodes?: Array<Record<string, unknown>>
        }
        return {
          taskId: row.taskId,
          taskOwnerUserId: row.taskOwnerUserId,
          nodes: (parsed.nodes ?? [])
            .filter(
              (node): node is Record<string, unknown> & { id: string } =>
                node.kind === 'review' && typeof node.id === 'string' && node.id.length > 0,
            )
            .map((node) => ({
              reviewNodeId: node.id,
              title: typeof node.title === 'string' ? node.title : '',
              description: typeof node.description === 'string' ? node.description : '',
            })),
        }
      } catch {
        return { taskId: row.taskId, taskOwnerUserId: row.taskOwnerUserId, nodes: [] }
      }
    },
  }

  const reviewGateSubjects: ReviewGateSubjectReadModel = {
    async find(nodeRunId) {
      const rows = await db
        .select({
          nodeRunId: docVersions.reviewNodeRunId,
          taskId: docVersions.taskId,
          reviewNodeId: docVersions.reviewNodeId,
          taskOwnerUserId: tasks.ownerUserId,
        })
        .from(docVersions)
        .innerJoin(tasks, eq(tasks.id, docVersions.taskId))
        .where(eq(docVersions.reviewNodeRunId, nodeRunId))
        .limit(1)
      return rows[0] ?? null
    },
  }

  return Object.freeze({
    statusProjection,
    callGraphWorkspace,
    taskReviewNodes,
    reviewGateSubjects,
  })
}
