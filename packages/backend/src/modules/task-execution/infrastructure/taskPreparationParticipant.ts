import { eq } from 'drizzle-orm'
import type { PersistenceTx } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { writeTaskWorkspaceDirectoriesInTx } from './taskWorkspaceDirectoryParticipant'
import type { TaskPreparationParticipant } from '../application/ports/taskPreparation'

export function createTaskPreparationParticipantInTx(
  tx: PersistenceTx,
): TaskPreparationParticipant {
  return {
    async writeWorkspace(input) {
      const { tasks, taskRepos } = tablesOf(tx)
      const head = input.repositories[0]
      await tx
        .update(tasks)
        .set({
          worktreePath: input.worktreePath,
          branch: input.branch,
          baseCommit: input.baseCommit,
          repoPath: head?.repoPath ?? '',
          repoUrl: head?.repoUrl ?? null,
          cachedRepoId: head?.cachedRepoId ?? null,
          baseBranch: head?.baseBranch ?? '',
          repoCount: Math.max(1, input.repositories.length),
          spaceKind: input.spaceKind,
        })
        .where(eq(tasks.id, input.taskId))
      if (input.repositories.length > 0) {
        await tx.insert(taskRepos).values(
          input.repositories.map(({ ordinal, ...mount }) => ({
            ...mount,
            taskId: input.taskId,
            repoIndex: ordinal,
            worktreeDirName: mount.mountPath,
            schemaVersion: 1,
          })),
        )
      }
      await writeTaskWorkspaceDirectoriesInTx(
        tx,
        input.taskId,
        input.repositories.map((repo) => repo.mountPath),
        input.nodePaths,
      )
    },
  }
}
