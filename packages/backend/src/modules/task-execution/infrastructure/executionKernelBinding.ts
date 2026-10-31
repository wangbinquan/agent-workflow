import type {
  IsolatedAgentRunBinding,
  IsolationCleanupBinding,
} from '../application/ports/executionKernel'
import type { TaskExecutionEffectPersistence } from '../application/ports/taskExecutionEffectStore'
import { createLocalEffectAttemptObserver } from '../application/localEffectObserver'
import { currentTaskExecutionContext } from '../composition/sqliteTaskExecutionContext'
import { discardIsolatedWorkspace } from './isolationWorkspaceView'

/** Bind the existing observer at its original creation site, with the same context lookup. */
export function bindIsolationKernel(
  input: Omit<IsolatedAgentRunBinding, 'createLocalEffectAttemptObserver'> & {
    readonly effects: TaskExecutionEffectPersistence
  },
): IsolatedAgentRunBinding {
  return {
    workspace: input.workspace,
    artifactPaths: input.artifactPaths,
    mergeStates: input.mergeStates,
    nodeExecution: input.nodeExecution,
    ...(input.executionContext === undefined ? {} : { executionContext: input.executionContext }),
    createLocalEffectAttemptObserver: (request) =>
      createLocalEffectAttemptObserver({ ...request, persistence: input.effects }),
  }
}

/** Preserve SQLite compatibility-context participation, including lazy lookup after passthrough. */
export function bindIsolationCleanup(): IsolationCleanupBinding {
  return {
    discardIsolatedWorkspace,
    cleanupEffectFactory(taskId) {
      // Hosted contexts intentionally do not acquire a cleanup receipt before the write window:
      // that would invert the merge/create window -> fence order (RFC-370 acceptance).
      const context = currentTaskExecutionContext(taskId)
      return context === undefined
        ? undefined
        : (request) =>
            createLocalEffectAttemptObserver({
              ...request,
              persistence: context.persistence.effects,
              context,
            })
    },
  }
}
