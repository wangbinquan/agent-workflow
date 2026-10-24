import { eq } from 'drizzle-orm'
import { mountDepth } from '@agent-workflow/shared'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { taskRequestedSourceColumns } from './taskRepositorySql'
import { decodeRequestedSource } from '@/platform/persistence/taskRepositorySurface'
import { taskRepositoryNodePaths } from '../domain/taskRepository'
import { ValidationError } from '@/util/errors'
import type { TaskPreparationQueries } from '../application/ports/taskPreparation'

export function createTaskPreparationQueries(db: PersistenceDb): TaskPreparationQueries {
  return {
    async context(taskId) {
      const { tasks } = tablesOf(db)
      const row = (
        await db
          .select({
            id: tasks.id,
            status: tasks.status,
            workflowId: tasks.workflowId,
            name: tasks.name,
            ...taskRequestedSourceColumns(db),
            workingBranch: tasks.workingBranch,
            gitUserName: tasks.gitUserName,
            gitUserEmail: tasks.gitUserEmail,
            worktreePath: tasks.worktreePath,
            workspacePruningAt: tasks.workspacePruningAt,
            workspacePrunedAt: tasks.workspacePrunedAt,
          })
          .from(tasks)
          .where(eq(tasks.id, taskId))
          .limit(1)
      )[0]

      if (row === undefined) return undefined
      return {
        id: row.id,
        status: row.status,
        workflowId: row.workflowId,
        name: row.name,
        spaceKind: row.spaceKind,
        workingBranch: row.workingBranch,
        gitUserName: row.gitUserName,
        gitUserEmail: row.gitUserEmail,
        worktreePath: row.worktreePath,
        workspacePruningAt: row.workspacePruningAt,
        workspacePrunedAt: row.workspacePrunedAt,
        requestedSource: decodeRequestedSource(row),
      }
    },
    async status(taskId) {
      const { tasks } = tablesOf(db)
      return (await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId)))[0]
    },
    async frozenLayout(sourceTaskId) {
      const { taskRepos, taskSpaceNodes } = tablesOf(db)
      const rows = await db
        .select()
        .from(taskRepos)
        .where(eq(taskRepos.taskId, sourceTaskId))
        .orderBy(taskRepos.repoIndex)

      if (rows.length === 0) {
        throw new ValidationError(
          'source-task-not-replayable',
          `task '${sourceTaskId}' has no frozen repo snapshot to relaunch from`,
        )
      }
      const missing = rows.filter((r) => (r.cachedRepoId ?? '') === '')
      if (missing.length > 0) {
        throw new ValidationError(
          'source-task-not-replayable',
          `task '${sourceTaskId}' has ${missing.length} repo(s) with no cached mirror id; ` +
            'its space cannot be replayed (relaunch by picking a repo or repo group instead)',
        )
      }
      const repos = rows.map((r) => ({
        cachedRepoId: r.cachedRepoId as string,
        repoUrlRedacted: r.repoUrl ?? '',
        ref: r.baseBranch,
        subdir: r.subdir,
        mountPath: r.mountPath,
        readonly: r.readonly,
        viaGroups: [],
      }))
      const frozenNodes = await db
        .select({ path: taskSpaceNodes.nodePath })
        .from(taskSpaceNodes)
        .where(eq(taskSpaceNodes.taskId, sourceTaskId))

      const nodePaths =
        frozenNodes.length > 0
          ? frozenNodes
              .map((row) => row.path)
              .sort((a, b) => mountDepth(a) - mountDepth(b) || a.localeCompare(b))
          : taskRepositoryNodePaths(repos.map((repo) => repo.mountPath))
      return {
        repos,
        nodes: nodePaths.map((path) => ({ path, origins: [] })),
      }
    },
  }
}
