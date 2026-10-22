// RFC-359 W4-B5 —— 代码工作区读取：一份实现，两个 provider 共用。

import { tablesOf } from '@/platform/persistence/sessionTables'
import { asc, eq } from 'drizzle-orm'

import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { engineOf } from '@/platform/persistence/databaseTransaction'
import type {
  CodeNodeRunSnapshot,
  CodeWorkspaceRead,
  CodeWorkspaceRepository,
  CodeWorkspaceTask,
} from '../application/ports/codeWorkspaceRead'

/** 查询时再取列：表是按 provider 投影的代理，顶层捕获会钉死在加载时的 provider（见 dev-gotchas）。 */
function nodeProjection(db: object) {
  const { nodeRuns } = tablesOf(db)
  return {
    id: nodeRuns.id,
    seq: nodeRuns.seq,
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

export function createCodeWorkspaceRead(db: PersistenceDb): CodeWorkspaceRead {
  return {
    async findTask(taskId): Promise<CodeWorkspaceTask | null> {
      const { tasks, taskRepos } = tablesOf(db)
      const rows = await db
        .select({
          id: tasks.id,
          status: tasks.status,
          spaceKind: tasks.spaceKind,
          worktreePath: tasks.worktreePath,
          baseCommit: tasks.baseCommit,
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
      const { nodeRuns } = tablesOf(db)
      // 未启动的 run（started_at NULL）两个引擎都排最前：SQLite 的缺省，PG 须显式 nulls first。
      return await db
        .select(nodeProjection(db))
        .from(nodeRuns)
        .where(eq(nodeRuns.taskId, taskId))
        .orderBy(
          engineOf(db).ascNullsFirst(nodeRuns.startedAt),
          engineOf(db).ascNullsFirst(nodeRuns.seq),
          asc(nodeRuns.id),
        )
    },
    async findNodeRun(nodeRunId): Promise<CodeNodeRunSnapshot | null> {
      const { nodeRuns } = tablesOf(db)
      const rows = await db
        .select(nodeProjection(db))
        .from(nodeRuns)
        .where(eq(nodeRuns.id, nodeRunId))
        .limit(1)
      return rows[0] ?? null
    },
  }
}
