import { asc, eq } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { nodeRuns, taskRepos, tasks } from '@/db/schema'
import type {
  CodeNodeRunSnapshot,
  CodeWorkspaceRead,
  CodeWorkspaceRepository,
  CodeWorkspaceTask,
} from '../application/ports/codeWorkspaceRead'

const nodeProjection = {
  id: nodeRuns.id,
  preSnapshot: nodeRuns.preSnapshot,
  preSnapshotReposJson: nodeRuns.preSnapshotReposJson,
  startedAt: nodeRuns.startedAt,
  wrapperProgressJson: nodeRuns.wrapperProgressJson,
}

function fallbackRepository(task: {
  readonly worktreePath: string
  readonly baseCommit: string | null
}): CodeWorkspaceRepository {
  return {
    mountPath: '',
    worktreeDirName: '',
    worktreePath: task.worktreePath,
    baseCommit: task.baseCommit,
  }
}

export function createSqliteCodeWorkspaceRead(db: DbClient): CodeWorkspaceRead {
  return {
    async findTask(taskId): Promise<CodeWorkspaceTask | null> {
      const rows = await db
        .select({
          id: tasks.id,
          status: tasks.status,
          spaceKind: tasks.spaceKind,
          worktreePath: tasks.worktreePath,
          baseCommit: tasks.baseCommit,
          repoCount: tasks.repoCount,
        })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .limit(1)
      const task = rows[0]
      if (task === undefined) return null
      const repos = await db
        .select({
          mountPath: taskRepos.mountPath,
          worktreeDirName: taskRepos.worktreeDirName,
          worktreePath: taskRepos.worktreePath,
          baseCommit: taskRepos.baseCommit,
        })
        .from(taskRepos)
        .where(eq(taskRepos.taskId, taskId))
        .orderBy(asc(taskRepos.repoIndex))
      return {
        ...task,
        repos: repos.length > 0 ? repos : [fallbackRepository(task)],
      }
    },
    async listNodeRuns(taskId): Promise<readonly CodeNodeRunSnapshot[]> {
      return db
        .select(nodeProjection)
        .from(nodeRuns)
        .where(eq(nodeRuns.taskId, taskId))
        .orderBy(asc(nodeRuns.startedAt), asc(nodeRuns.id))
    },
    async findNodeRun(nodeRunId): Promise<CodeNodeRunSnapshot | null> {
      const rows = await db
        .select(nodeProjection)
        .from(nodeRuns)
        .where(eq(nodeRuns.id, nodeRunId))
        .limit(1)
      return rows[0] ?? null
    },
  }
}
