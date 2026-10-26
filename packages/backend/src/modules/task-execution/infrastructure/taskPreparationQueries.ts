import { projectTaskMountReadRow } from './taskRepositorySql'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { ValidationError } from '@/util/errors'
import { mountDepth } from '@agent-workflow/shared'
import { eq } from 'drizzle-orm'
import type { TaskPreparationQueries } from '../application/ports/taskPreparation'
import { decodeRequestedSourceJson, requestedSourceView } from '../domain/requestedSourceCodec'
import {
  taskMountReadColumns,
  taskReadColumns,
  taskRequestedSourceColumns,
} from './taskRepositorySql'

export function createTaskPreparationQueries(db: PersistenceDb): TaskPreparationQueries {
  return {
    async context(taskId) {
      const { tasks } = tablesOf(db)
      const row = (
        await db
          .select({
            id: tasks.id,
            status: tasks.status,
            workflowId: taskReadColumns(db).workflowId,
            subjectKind: taskReadColumns(db).subjectKind,
            sourceId: taskReadColumns(db).sourceId,
            sourceName: taskReadColumns(db).sourceName,
            name: tasks.name,
            ...taskRequestedSourceColumns(db),
            workingBranch: taskReadColumns(db).workingBranch,
            gitUserName: taskReadColumns(db).gitUserName,
            gitUserEmail: taskReadColumns(db).gitUserEmail,
            worktreePath: taskReadColumns(db).worktreePath,
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
        requestedSource: requestedSourceView(decodeRequestedSourceJson(row.requestedSource)),
      }
    },
    async status(taskId) {
      const { tasks } = tablesOf(db)
      return (await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId)))[0]
    },
    async frozenLayout(sourceTaskId) {
      const { taskSpaceNodes } = tablesOf(db)
      const { taskRepositoryMounts: taskRepos } = tablesOf(db)
      const rows = await db
        .select(taskMountReadColumns(db))
        .from(taskRepos)
        .where(eq(taskRepos.taskId, sourceTaskId))
        .orderBy(taskRepos.ordinal)
        .then((rows) => rows.map(projectTaskMountReadRow))

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
          : []
      return {
        repos,
        nodes: nodePaths.map((path) => ({ path, origins: [] })),
      }
    },
  }
}
