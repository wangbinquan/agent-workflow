import type { TaskMechanicsState } from '@/services/execution/taskMechanicsState'
import type { ExecutionWorkspaceSession } from '../application/ports/executionWorkspaceSession'
import { createExecutionWorkspaceSession } from '../infrastructure/executionWorkspaceSession'

// One session per mechanics state object, exactly as the retired composition/isolationWorkspaceScene.ts side
// table did (a copied state gets its own session). RFC-402 keeps the side table until later S6 steps dissolve
// TaskMechanicsState: a field on the services-owned state bag would need the session type in task-execution's
// public surface, which may not reference platform contracts.
const sessions = new WeakMap<object, ExecutionWorkspaceSession>()

export function workspaceSessionFor(
  state: Pick<TaskMechanicsState, 'taskId' | 'opts' | 'repos'>,
): ExecutionWorkspaceSession {
  let session = sessions.get(state)
  if (session === undefined) {
    session = createTaskWorkspaceSession(() => state)
    sessions.set(state, session)
  }
  return session
}

/** Preserve factory/binding re-selection without making the infrastructure depend on mechanics. */
export function createTaskWorkspaceSession(
  state: () => Pick<TaskMechanicsState, 'taskId' | 'opts' | 'repos'>,
) {
  return createExecutionWorkspaceSession(() => {
    const current = state()
    return {
      factory: current.opts.isolationWorkspaces,
      binding: {
        taskId: current.taskId,
        storageRootRef: current.opts.appHome,
        repositories: current.repos.map((repo) => ({
          repositoryRef: repo.repoPath,
          workspaceRef: repo.worktreePath,
          mount: repo.mountPath,
          baseBranch: repo.baseBranch,
        })),
      },
    }
  })
}
