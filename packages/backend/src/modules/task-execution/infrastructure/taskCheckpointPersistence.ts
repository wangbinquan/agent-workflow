import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { asc, eq } from 'drizzle-orm'
import type { TaskMountKeysReaderInTx } from '../application/ports/taskMountKeys'

export const taskMountKeysReader: TaskMountKeysReaderInTx = {
  async list(tx, taskId) {
    const { taskRepositoryMounts } = tablesOf(tx)
    return await tx
      .select({
        repoKey: taskRepositoryMounts.repoKey,
        ordinal: taskRepositoryMounts.ordinal,
        mountPath: taskRepositoryMounts.mountPath,
      })
      .from(taskRepositoryMounts)
      .where(eq(taskRepositoryMounts.taskId, taskId))
      .orderBy(asc(taskRepositoryMounts.ordinal))
  },
}

/** Checkpoint writers see real mounts; DTO placeholders never become checkpoints. */
export async function taskCheckpointMountPaths(
  db: PersistenceDb,
  taskId: string,
): Promise<string[]> {
  return (await taskMountKeysReader.list(db, taskId)).map((repo) => repo.mountPath)
}
