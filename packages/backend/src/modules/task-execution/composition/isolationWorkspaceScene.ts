import type { TaskMechanicsState } from '@/services/execution/taskMechanicsState'
import type {
  IsolationRestoreInput,
  IsolationWorkspaceBinding,
  IsolationWorkspaceFactory,
  IsolationWorkspaceScope,
} from '@/modules/source-control/public/types'
import { requireIsolationWorkspaceScope } from '@/modules/source-control/public/participants'
import { workspaceView } from '../infrastructure/isolationWorkspaceView'

interface Scene {
  readonly factory: IsolationWorkspaceFactory
  readonly identity: string
  readonly scope: Promise<IsolationWorkspaceScope>
}
const scenes = new WeakMap<TaskMechanicsState, Scene>()

/** References are copied as values; only the selected adapter interprets them. */
function bindingOf(state: TaskMechanicsState): IsolationWorkspaceBinding {
  return {
    taskId: state.taskId,
    storageRootRef: state.opts.appHome,
    repositories: state.repos.map((repo) => ({
      repositoryRef: repo.repoPath,
      workspaceRef: repo.worktreePath,
      mount: repo.worktreeDirName,
      baseBranch: repo.baseBranch,
    })),
  }
}

export function isolationScopeFor(state: TaskMechanicsState): Promise<IsolationWorkspaceScope> {
  const factory = state.opts.isolationWorkspaces
  const binding = bindingOf(state)
  const identity = JSON.stringify(binding)
  const previous = scenes.get(state)
  if (previous?.factory === factory && previous.identity === identity) return previous.scope
  const scope = Promise.resolve().then(async () => {
    const receiver = await factory.bind(binding)
    requireIsolationWorkspaceScope(receiver)
    return receiver
  })
  const scene: Scene = { factory, identity, scope }
  scenes.set(state, scene)
  void scope.catch(() => {
    if (scenes.get(state) === scene) scenes.delete(state)
  })
  return scope
}

export async function restoreTaskIsolation(
  state: TaskMechanicsState,
  input: IsolationRestoreInput,
) {
  const scope = await isolationScopeFor(state)
  return workspaceView(scope, await scope.restore(input))
}

export function restoredSubmodules(
  input: Record<
    string,
    {
      subBases: Record<string, string>
      poolDirs?: Record<string, string>
      pendingSubResolves?: string[]
    }
  >,
): NonNullable<IsolationRestoreInput['submodules']> {
  return Object.fromEntries(
    Object.entries(input).map(([mount, value]) => [
      mount,
      {
        submoduleBases: value.subBases,
        ...(value.poolDirs === undefined ? {} : { poolRefs: value.poolDirs }),
        ...(value.pendingSubResolves === undefined
          ? {}
          : { pendingSubResolutions: value.pendingSubResolves }),
      },
    ]),
  )
}
