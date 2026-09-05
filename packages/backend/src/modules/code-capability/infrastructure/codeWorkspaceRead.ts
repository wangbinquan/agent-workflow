// RFC-359 W4-B5 —— 代码工作区读取：一份实现，两个 provider 共用。

import { asc, eq } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import { nodeRuns, taskRepos, tasks } from '@/db/schema'
import { engineOf } from '@/platform/persistence/databaseTransaction'
import type {
  CodeNodeRunSnapshot,
  CodeWorkspaceRead,
  CodeWorkspaceRepository,
  CodeWorkspaceTask,
} from '../application/ports/codeWorkspaceRead'

/** 查询时再取列：表是按 provider 投影的代理，顶层捕获会钉死在加载时的 provider（见 dev-gotchas）。 */
function nodeProjection() {
  return {
    id: nodeRuns.id,
    preSnapshot: nodeRuns.preSnapshot,
    preSnapshotReposJson: nodeRuns.preSnapshotReposJson,
    startedAt: nodeRuns.startedAt,
    wrapperProgressJson: nodeRuns.wrapperProgressJson,
  }
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

export function createCodeWorkspaceRead(db: ProviderNeutralDatabase): CodeWorkspaceRead {
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
      // 未启动的 run（started_at NULL）两个引擎都排最前：SQLite 的缺省，PG 须显式 nulls first。
      return await db
        .select(nodeProjection())
        .from(nodeRuns)
        .where(eq(nodeRuns.taskId, taskId))
        .orderBy(engineOf(db).ascNullsFirst(nodeRuns.startedAt), asc(nodeRuns.id))
    },
    async findNodeRun(nodeRunId): Promise<CodeNodeRunSnapshot | null> {
      const rows = await db
        .select(nodeProjection())
        .from(nodeRuns)
        .where(eq(nodeRuns.id, nodeRunId))
        .limit(1)
      return rows[0] ?? null
    },
  }
}
