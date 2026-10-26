import { projectTaskMountReadRow } from './taskRepositorySql'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { isTerminalTaskStatus, type TaskStatus } from '@agent-workflow/shared'
import { eq, inArray } from 'drizzle-orm'
import type { TaskDeletionQueries } from '../application/ports/taskDeletion'
import { taskMountReadColumns, taskReadColumns } from './taskRepositorySql'

export function createTaskDeletionQueries(db: PersistenceDb): TaskDeletionQueries {
  const { tasks, taskRepositoryMounts: taskRepos } = tablesOf(db)
  return {
    async read(taskId) {
      return (
        await db
          .select({
            id: tasks.id,
            status: tasks.status,
            spaceKind: taskReadColumns(db).spaceKind,
            worktreePath: taskReadColumns(db).worktreePath,
            repoPath: taskReadColumns(db).repoPath,
            parentTaskId: tasks.parentTaskId,
            parentNodeRunId: taskReadColumns(db).parentNodeRunId,
          })
          .from(tasks)
          .where(eq(tasks.id, taskId))
          .limit(1)
      )[0]
    },
    async status(taskId) {
      return (
        await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId)).limit(1)
      )[0]
    },
    async workspaces(taskIds) {
      const memberTaskRows = await db
        .select({
          id: tasks.id,
          spaceKind: taskReadColumns(db).spaceKind,
          repoPath: taskReadColumns(db).repoPath,
          worktreePath: taskReadColumns(db).worktreePath,
        })
        .from(tasks)
        .where(inArray(tasks.id, [...taskIds]))
      const repoRows = await db
        .select({
          taskId: taskRepos.taskId,
          mountPath: taskRepos.mountPath,
          repoPath: taskRepos.repoPath,
          workspaceRootRef: taskMountReadColumns(db).workspaceRootRef,
        })
        .from(taskRepos)
        .where(inArray(taskRepos.taskId, [...taskIds]))
      return {
        tasks: memberTaskRows,
        repositories: repoRows
          .map(projectTaskMountReadRow)
          .map(({ mountPath: _mountPath, ...row }) => row),
      }
    },
    async nonTerminalDescendant(rootId) {
      const visited = new Set<string>([rootId])
      let frontier = [rootId]
      while (frontier.length > 0) {
        const { tasks } = tablesOf(db)
        const children = await db
          .select({ id: tasks.id, status: tasks.status, parentTaskId: tasks.parentTaskId })
          .from(tasks)
          .where(inArray(tasks.parentTaskId, frontier))
        frontier = []
        for (const c of children) {
          if (visited.has(c.id)) continue
          visited.add(c.id)
          if (!isTerminalTaskStatus(c.status as TaskStatus)) return { id: c.id, status: c.status }
          frontier.push(c.id)
        }
      }
      return null
    },
  }
}
