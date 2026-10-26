import { projectTaskMountReadRow } from './taskRepositorySql'
import { createRunSelectionReader } from './runSelection/table/reader'
import { readNodeRunRows } from './nodeRunQueries'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { taskMountReadColumns, taskReadColumns } from './taskRepositorySql'
// RFC-359 W4-B5 —— 代码工作区读取：一份实现，两个 provider 共用。

import { projectStoredTaskRepositorySurface } from '@/platform/persistence/taskRepositorySurface'
import { asc, eq } from 'drizzle-orm'

import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type {
  CodeNodeRunSnapshot,
  CodeWorkspaceTask,
  TaskCodeWorkspaceQueries,
} from '../application/ports/taskCodeWorkspaceQueries'

export function createTaskCodeWorkspaceQueries(db: PersistenceDb): TaskCodeWorkspaceQueries {
  return {
    async findTask(taskId): Promise<CodeWorkspaceTask | null> {
      const { tasks, taskRepositoryMounts: taskRepos } = tablesOf(db)
      const rows = await db
        .select({
          id: tasks.id,
          status: tasks.status,
          spaceKind: taskReadColumns(db).spaceKind,
          worktreePath: taskReadColumns(db).worktreePath,
          baseCommit: taskReadColumns(db).baseCommit,
          finishedAt: tasks.finishedAt,
        })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .limit(1)
      const task = rows[0]
      if (task === undefined) return null
      const repos = await db
        .select({
          mountPath: taskRepos.mountPath,
          workspaceRootRef: taskMountReadColumns(db).workspaceRootRef,
          baseCommit: taskRepos.baseCommit,
        })
        .from(taskRepos)
        .where(eq(taskRepos.taskId, taskId))
        .orderBy(asc(taskRepos.ordinal))
        .then((rows) => rows.map(projectTaskMountReadRow))
      return {
        ...task,
        repos:
          repos.length > 0
            ? repos
            : projectStoredTaskRepositorySurface(task).repos.map(
                ({ mountPath, worktreePath, baseCommit }) => ({
                  mountPath,
                  worktreePath,
                  baseCommit,
                }),
              ),
      }
    },
    async listNodeRuns(taskId): Promise<readonly CodeNodeRunSnapshot[]> {
      const history = await createRunSelectionReader(db).familyHistory(
        taskId,
        {},
        { order: 'api-timeline' },
      )
      const rows = new Map((await readNodeRunRows(db, { taskId })).map((row) => [row.run.id, row]))
      return history.flatMap(({ id }) => {
        const row = rows.get(id)
        return row
          ? [
              {
                id: row.run.id,
                seq: row.run.seq,
                startedAt: row.run.startedAt,
                wrapperProgressJson: row.runtime?.wrapperProgressJson ?? null,
                checkpoints: row.checkpoints,
              },
            ]
          : []
      })
    },
    async findNodeRun(nodeRunId): Promise<CodeNodeRunSnapshot | null> {
      const [row] = await readNodeRunRows(db, { runIds: [nodeRunId], limit: 1 })
      return row
        ? {
            id: row.run.id,
            seq: row.run.seq,
            startedAt: row.run.startedAt,
            wrapperProgressJson: row.runtime?.wrapperProgressJson ?? null,
            checkpoints: row.checkpoints,
          }
        : null
    },
  }
}
