import { isTaskWorkspaceUnbound } from '@agent-workflow/shared'
import { decodeRequestedSourceJson } from '../domain/requestedSourceCodec'
import type { PersistenceTx } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { and, eq } from 'drizzle-orm'
import type { TaskPreparationParticipant } from '../application/ports/taskPreparation'
import { taskMountsAtCreation } from '../domain/taskCreation'
import { TaskAggregateCasMiss, taskAggregateWrite } from './taskDefinitionWriteParticipant'
import { taskWorkspaceUnboundSql } from './taskRepositorySql'
import { writeTaskWorkspaceDirectoriesInTx } from './taskWorkspaceDirectoryParticipant'

export function createTaskPreparationParticipantInTx(
  tx: PersistenceTx,
): TaskPreparationParticipant {
  return {
    async writeWorkspace(input) {
      await taskAggregateWrite.lockTaskAggregateRoot(tx, input.taskId)
      const { tasks, taskWorkspaces, taskRepositoryMounts } = tablesOf(tx)
      const previous = (
        await tx
          .select({ revision: tasks.lifecycleEventRevision, root: tasks.workspaceRootRef })
          .from(tasks)
          .where(eq(tasks.id, input.taskId))
      )[0]
      if (!previous || previous.root !== null) throw new TaskAggregateCasMiss(input.taskId)
      const workspace = await tx
        .update(taskWorkspaces)
        .set({ spaceKind: input.spaceKind, taskBranch: input.branch })
        .where(eq(taskWorkspaces.taskId, input.taskId))
        .returning({
          requestedSource: taskWorkspaces.requestedSource,
          workingBranch: taskWorkspaces.workingBranch,
        })
      if (workspace.length !== 1) throw new TaskAggregateCasMiss(input.taskId)
      const source = decodeRequestedSourceJson(workspace[0]!.requestedSource)
      const mounts = taskMountsAtCreation(
        input.taskId,
        {
          repoPath: source.repoPath,
          repoUrl: source.repoUrl,
          cachedRepoId: source.cachedRepoId,
          baseBranch: source.requestedRef.value,
          workingBranch: workspace[0]!.workingBranch,
          worktreePath: input.worktreePath,
          branch: input.branch,
          baseCommit: input.baseCommit,
          spaceKind: input.spaceKind,
        },
        input.repositories,
      )
      if (mounts.length) await tx.insert(taskRepositoryMounts).values(mounts)
      await writeTaskWorkspaceDirectoriesInTx(
        tx,
        input.taskId,
        mounts.map((repo) => repo.mountPath),
        input.nodePaths,
      )
      const changed = await tx
        .update(tasks)
        .set({
          workspaceRootRef: isTaskWorkspaceUnbound(input.worktreePath) ? null : input.worktreePath,
        })
        .where(
          and(
            eq(tasks.id, input.taskId),
            eq(tasks.lifecycleEventRevision, previous.revision),
            taskWorkspaceUnboundSql(tasks.workspaceRootRef),
          ),
        )
        .returning({ id: tasks.id })
      if (changed.length !== 1) throw new TaskAggregateCasMiss(input.taskId)
    },
  }
}
