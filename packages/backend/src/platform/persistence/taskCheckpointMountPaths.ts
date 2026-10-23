import { asc, eq } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'

/** The epoch-1 no-task_repos fallback denotes a single root repository. */
export async function taskCheckpointMountPaths(
  db: PersistenceDb,
  taskId: string,
): Promise<string[]> {
  const { taskRepos } = tablesOf(db)
  const repos = await db
    .select({ mountPath: taskRepos.mountPath })
    .from(taskRepos)
    .where(eq(taskRepos.taskId, taskId))
    .orderBy(asc(taskRepos.repoIndex))
  return repos.length === 0 ? [''] : repos.map((repo) => repo.mountPath)
}
