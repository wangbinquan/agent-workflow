import { eq, inArray } from 'drizzle-orm'
import { isTerminalTaskStatus, type TaskStatus } from '@agent-workflow/shared'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import type { TaskDeletionQueries } from '../application/ports/taskDeletion'

export function createTaskDeletionQueries(db: PersistenceDb): TaskDeletionQueries {
  const { tasks, taskRepos } = tablesOf(db)
  return {
    async read(taskId) {
      return (
        await db
          .select({
            id: tasks.id,
            status: tasks.status,
            spaceKind: tasks.spaceKind,
            worktreePath: tasks.worktreePath,
            repoPath: tasks.repoPath,
            parentTaskId: tasks.parentTaskId,
            parentNodeRunId: tasks.parentNodeRunId,
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
          spaceKind: tasks.spaceKind,
          repoPath: tasks.repoPath,
          worktreePath: tasks.worktreePath,
        })
        .from(tasks)
        .where(inArray(tasks.id, [...taskIds]))
      const repoRows = await db
        .select({
          taskId: taskRepos.taskId,
          repoPath: taskRepos.repoPath,
          worktreePath: taskRepos.worktreePath,
        })
        .from(taskRepos)
        .where(inArray(taskRepos.taskId, [...taskIds]))
      return { tasks: memberTaskRows, repositories: repoRows }
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
