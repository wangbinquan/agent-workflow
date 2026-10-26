import { taskRepositoryNodePaths } from '@/platform/taskRepository'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'

/** Persist the mount ancestor closure and explicit directories at admission and preparation. */
export async function writeTaskWorkspaceDirectoriesInTx(
  tx: PersistenceDb,
  taskId: string,
  mountPaths: readonly string[],
  nodePaths: readonly string[],
): Promise<void> {
  const paths = taskRepositoryNodePaths(mountPaths, nodePaths)
  if (paths.length === 0) return
  const { taskSpaceNodes } = tablesOf(tx)
  await tx
    .insert(taskSpaceNodes)
    .values(
      paths.map((nodePath) => ({
        taskId,
        nodePath,
        schemaVersion: 1,
      })),
    )
    .onConflictDoNothing()
}
