import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'

/** Persists exactly the caller's resolved directories, at admission and at preparation (as HEAD). */
export async function writeTaskWorkspaceDirectoriesInTx(
  tx: PersistenceDb,
  taskId: string,
  _mountPaths: readonly string[],
  nodePaths: readonly string[],
): Promise<void> {
  // RFC-395 II-a: HEAD persists exactly the caller's resolved directories.
  // Inferring roots/ancestors here changes stored rows for inherited and prepared spaces.
  if (nodePaths.length === 0) return
  const { taskSpaceNodes } = tablesOf(tx)
  await tx
    .insert(taskSpaceNodes)
    .values(
      nodePaths.map((nodePath) => ({
        taskId,
        nodePath,
        schemaVersion: 1,
      })),
    )
    .onConflictDoNothing()
}
