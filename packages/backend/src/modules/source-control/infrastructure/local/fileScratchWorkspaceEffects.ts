import { isTaskWorkspaceUnbound } from '@agent-workflow/shared'
import { join } from 'node:path'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { ScratchWorkspaceEffects } from '../../application/ports/scratchWorkspaceEffects'
import type { WorkspaceCleanupHookEvent } from '../../application/workspaceMaterialization'
import { composeRepositoryWorkspaceStore } from '../repositoryWorkspaceStore'
import {
  materializeSpaceWithProvider,
  cleanupMaterializedSpaceLease,
  createMaterializedSpaceCleanup,
} from '../workspaceMaterializer'

export function createFileScratchWorkspaceEffects(input: {
  readonly db: PersistenceDb
  readonly appHome: string
  readonly workspaceCleanupHook?: (event: WorkspaceCleanupHookEvent) => void | Promise<void>
}) {
  return Object.freeze({
    async prepare(request: Parameters<ScratchWorkspaceEffects['prepare']>[0]) {
      return await materializeSpaceWithProvider(
        { scratch: true },
        {
          appHome: input.appHome,
          repositoryWorkspace: composeRepositoryWorkspaceStore(input.db),
          gitCommitIdentity: request.gitCommitIdentity,
          sourceTerminationLaunchSignal: request.signal,
          resumeExistingScratch: true,
          ...(input.workspaceCleanupHook === undefined
            ? {}
            : { workspaceCleanupHook: input.workspaceCleanupHook }),
          loadFrozenSpaceLayout: async () => {
            throw new Error('scratch-has-no-frozen-layout')
          },
        },
        request.taskId,
      )
    },
    restore(taskId: string, space: Parameters<ScratchWorkspaceEffects['restore']>[1]) {
      if (
        !isTaskWorkspaceUnbound(space.worktreePath) &&
        space.worktreePath !== join(input.appHome, 'scratch', taskId)
      )
        throw new Error('scratch-preparation-artifact-mismatch')
      return space
    },
    async cleanup(request: Parameters<ScratchWorkspaceEffects['cleanup']>[0]) {
      return await cleanupMaterializedSpaceLease(
        createMaterializedSpaceCleanup(
          request.taskId,
          join(input.appHome, 'scratch', request.taskId),
        ),
        async (event) => {
          await request.assertCurrent()
          await input.workspaceCleanupHook?.(event)
        },
      )
    },
  } satisfies ScratchWorkspaceEffects)
}
