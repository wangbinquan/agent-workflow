import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { eq, inArray, type SQL, type SQLWrapper } from 'drizzle-orm'
import type { TaskKnowledgeQueries } from '../application/ports/taskKnowledgeQueries'
import { definitionAnchorId, taskSubjectFromDefinition } from '../domain/taskSubject'
import { listNodeEventContents } from './nodeEventQueries'
import { taskReadColumns } from './taskRepositorySql'
import { taskWorkgroupConfigSelection } from './taskWorkgroupConfig'

/**
 * RFC-565: Source Control's same-statement repository existence fragment, as the distillation scope composes it into its
 * one task row read. Bootstrap hands over the owner's implementation; neither side references the other's tables.
 */
export type RepositoryExistsExpression = (
  db: PersistenceDb,
  repositoryId: SQLWrapper,
) => SQL<boolean>

/**
 * 注入与蒸馏消费的闭合投影；subject 解码和任务存储字段留在 owner。RFC-565：由 bootstrap 在根句柄上构造后交给 memory（不再从 public
 * 交出收句柄的工厂）。
 */
export function createTaskKnowledgeQueries(
  db: PersistenceDb,
  repositoryExists: RepositoryExistsExpression,
): TaskKnowledgeQueries {
  return {
    async injectionContext(taskId: string) {
      const { tasks } = tablesOf(db)
      const rows = await db
        .select({
          workflowId: taskReadColumns(db).workflowId,
          subjectKind: taskReadColumns(db).subjectKind,
          sourceId: taskReadColumns(db).sourceId,
          sourceName: taskReadColumns(db).sourceName,
          codeRoundId: taskReadColumns(db).codeRoundId,
          workgroupId: taskReadColumns(db).workgroupId,
          sourceAgentId: taskReadColumns(db).sourceAgentId,
          sourceAgentName: taskReadColumns(db).sourceAgentName,
          cachedRepoId: taskReadColumns(db).cachedRepoId,
          repoGroupId: taskReadColumns(db).repoGroupId,
        })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .limit(1)
      const row = rows[0]
      return row === undefined
        ? null
        : {
            workflowId: definitionAnchorId(taskSubjectFromDefinition(row)),
            cachedRepoId: row.cachedRepoId,
            repoGroupId: row.repoGroupId,
          }
    },
    async repositoryIds(taskId: string): Promise<readonly string[]> {
      const { taskRepositoryMounts: taskRepos } = tablesOf(db)
      return (
        await db
          .select({ cachedRepoId: taskRepos.cachedRepoId })
          .from(taskRepos)
          .where(eq(taskRepos.taskId, taskId))
      ).flatMap((row) => (row.cachedRepoId === null ? [] : [row.cachedRepoId]))
    },
    async distillationScope(taskId: string) {
      const { tasks } = tablesOf(db)
      const row = (
        await db
          .select({
            workflowSnapshot: taskReadColumns(db).workflowSnapshot,
            workgroupConfig: taskWorkgroupConfigSelection(db),
            workflowId: taskReadColumns(db).workflowId,
            subjectKind: taskReadColumns(db).subjectKind,
            sourceId: taskReadColumns(db).sourceId,
            sourceName: taskReadColumns(db).sourceName,
            codeRoundId: taskReadColumns(db).codeRoundId,
            workgroupId: taskReadColumns(db).workgroupId,
            sourceAgentId: taskReadColumns(db).sourceAgentId,
            sourceAgentName: taskReadColumns(db).sourceAgentName,
            cachedRepoId: taskReadColumns(db).cachedRepoId,
            cachedRepoExists: repositoryExists(db, taskReadColumns(db).cachedRepoId),
            // RFC-366 admission facts — same row, no extra query.
            launchOrigin: taskReadColumns(db).launchOrigin,
            catalogVisibility: tasks.catalogVisibility,
            spaceKind: taskReadColumns(db).spaceKind,
          })
          .from(tasks)
          .where(eq(tasks.id, taskId))
          .limit(1)
      )[0]
      return row === undefined
        ? null
        : {
            workflowSnapshot: row.workflowSnapshot,
            workgroupConfig: row.workgroupConfig,
            workflowId: definitionAnchorId(taskSubjectFromDefinition(row)),
            cachedRepoId: row.cachedRepoId,
            cachedRepoExists: row.cachedRepoExists,
            launchOrigin: row.launchOrigin,
            catalogVisibility: row.catalogVisibility,
            spaceKind: row.spaceKind,
          }
    },
    async distillationSources(ids: readonly string[]) {
      if (ids.length === 0) return []
      const { tasks } = tablesOf(db)
      return await db
        .select({
          id: tasks.id,
          name: tasks.name,
          status: tasks.status,
          startedAt: tasks.startedAt,
          finishedAt: tasks.finishedAt,
          runningMs: tasks.runningMs,
          errorSummary: tasks.errorSummary,
          errorMessage: tasks.errorMessage,
          failedNodeId: tasks.failedNodeId,
          inputs: taskReadColumns(db).inputs,
          workflowSnapshot: taskReadColumns(db).workflowSnapshot,
        })
        .from(tasks)
        .where(inArray(tasks.id, [...ids]))
    },
    async distillationEvents(nodeRunIds: readonly string[]) {
      return listNodeEventContents(db, nodeRunIds)
    },
  }
}
