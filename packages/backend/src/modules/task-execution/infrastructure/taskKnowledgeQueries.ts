import type { TaskKnowledgeQueries } from '../application/ports/taskKnowledgeQueries'
import { eq, inArray } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { repositoryExistsExpression } from '@/modules/source-control/public/queries'
import { decodeTaskSubject, definitionAnchorId } from '../domain/taskSubject'
import { taskWorkgroupConfigSelection } from './taskWorkgroupConfig'

/** 注入与蒸馏消费的闭合投影；subject 解码和任务存储字段留在 owner。 */
export function createTaskKnowledgeQueries(db: PersistenceDb): TaskKnowledgeQueries {
  return {
    async injectionContext(taskId: string) {
      const { tasks } = tablesOf(db)
      const rows = await db
        .select({
          workflowId: tasks.workflowId,
          codeRoundId: tasks.codeRoundId,
          workgroupId: tasks.workgroupId,
          sourceAgentId: tasks.sourceAgentId,
          sourceAgentName: tasks.sourceAgentName,
          cachedRepoId: tasks.cachedRepoId,
          repoGroupId: tasks.repoGroupId,
        })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .limit(1)
      const row = rows[0]
      return row === undefined
        ? null
        : {
            workflowId: definitionAnchorId(decodeTaskSubject(row)),
            cachedRepoId: row.cachedRepoId,
            repoGroupId: row.repoGroupId,
          }
    },
    async repositoryIds(taskId: string): Promise<readonly string[]> {
      const { taskRepos } = tablesOf(db)
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
            workflowSnapshot: tasks.workflowSnapshot,
            workgroupConfig: taskWorkgroupConfigSelection(db),
            workflowId: tasks.workflowId,
            codeRoundId: tasks.codeRoundId,
            workgroupId: tasks.workgroupId,
            sourceAgentId: tasks.sourceAgentId,
            sourceAgentName: tasks.sourceAgentName,
            cachedRepoId: tasks.cachedRepoId,
            cachedRepoExists: repositoryExistsExpression(db, tasks.cachedRepoId),
            // RFC-366 admission facts — same row, no extra query.
            launchOrigin: tasks.launchOrigin,
            catalogVisibility: tasks.catalogVisibility,
            spaceKind: tasks.spaceKind,
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
            workflowId: definitionAnchorId(decodeTaskSubject(row)),
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
          inputs: tasks.inputs,
          workflowSnapshot: tasks.workflowSnapshot,
        })
        .from(tasks)
        .where(inArray(tasks.id, [...ids]))
    },
  }
}
