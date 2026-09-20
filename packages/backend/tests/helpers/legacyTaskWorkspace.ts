// Test-only binding to the real SC mechanisms; no production service facade.
import type { StartTask } from '@agent-workflow/shared'
import type { StartTaskDeps } from '@/services/task'
import { Paths } from '@/util/paths'
import { composeSqliteRepositoryWorkspaceStore } from '@/modules/source-control/composition'
import { loadFrozenSpaceLayout } from '@/modules/task-execution/infrastructure/frozenWorkspaceLayout'
import {
  materializeSpaceWithProvider,
  resolveRepoSourceSingleWithProvider,
  type MaterializedSpace,
  type RepoSourceSpec,
  type ResolvedRepoSource,
} from '@/modules/source-control/infrastructure/workspaceMaterializer'
function repositoryWorkspaceFor(deps: Pick<StartTaskDeps, 'db' | 'repositoryWorkspace'>) {
  return deps.repositoryWorkspace ?? composeSqliteRepositoryWorkspaceStore(deps.db)
}

export async function resolveRepoSourceSingle(
  spec: RepoSourceSpec,
  input: StartTask,
  deps: StartTaskDeps,
): Promise<ResolvedRepoSource> {
  const appHome = deps.appHome ?? Paths.root
  return await resolveRepoSourceSingleWithProvider(spec, input, {
    appHome,
    repositoryWorkspace: repositoryWorkspaceFor(deps),
    loadFrozenSpaceLayout: async (sourceTaskId) =>
      await loadFrozenSpaceLayout(deps.db, sourceTaskId),
    ...(deps.secretBox === undefined ? {} : { secretBox: deps.secretBox }),
    ...(deps.cloneTimeoutMs === undefined ? {} : { cloneTimeoutMs: deps.cloneTimeoutMs }),
    ...(deps.internalSource === undefined ? {} : { internalSource: deps.internalSource }),
    ...(deps.preResolvedSource === undefined ? {} : { preResolvedSource: deps.preResolvedSource }),
    ...(deps.gitCommitIdentity === undefined ? {} : { gitCommitIdentity: deps.gitCommitIdentity }),
    ...(deps.sourceTerminationLaunchSignal === undefined
      ? {}
      : { sourceTerminationLaunchSignal: deps.sourceTerminationLaunchSignal }),
    ...(deps.workspaceCleanupHook === undefined
      ? {}
      : { workspaceCleanupHook: deps.workspaceCleanupHook }),
  })
}

export async function materializeSpace(
  input: StartTask,
  deps: StartTaskDeps,
  appHome: string,
  presetTaskId?: string,
): Promise<MaterializedSpace> {
  return await materializeSpaceWithProvider(
    input,
    {
      appHome,
      repositoryWorkspace: repositoryWorkspaceFor(deps),
      loadFrozenSpaceLayout: async (sourceTaskId) =>
        await loadFrozenSpaceLayout(deps.db, sourceTaskId),
      ...(deps.secretBox === undefined ? {} : { secretBox: deps.secretBox }),
      ...(deps.cloneTimeoutMs === undefined ? {} : { cloneTimeoutMs: deps.cloneTimeoutMs }),
      ...(deps.internalSource === undefined ? {} : { internalSource: deps.internalSource }),
      ...(deps.preResolvedSource === undefined
        ? {}
        : { preResolvedSource: deps.preResolvedSource }),
      ...(deps.gitCommitIdentity === undefined
        ? {}
        : { gitCommitIdentity: deps.gitCommitIdentity }),
      ...(deps.sourceTerminationLaunchSignal === undefined
        ? {}
        : { sourceTerminationLaunchSignal: deps.sourceTerminationLaunchSignal }),
      ...(deps.workspaceCleanupHook === undefined
        ? {}
        : { workspaceCleanupHook: deps.workspaceCleanupHook }),
    },
    presetTaskId,
  )
}
