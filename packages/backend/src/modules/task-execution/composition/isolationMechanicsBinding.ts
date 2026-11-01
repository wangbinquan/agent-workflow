// RFC-413 — the isolation mechanics ports over one execution state, and the pre-drive merge recovery they drive.
// Every value is read when the kernel asks for it; the kernel binding, the cleanup binding and the merge agent's
// ports are built at each use, exactly where the moved bodies built them.
import type { ExecutionMergeRecovery } from '../application/recovery/executionMergeRecovery'
import type { IsolationMechanicsPorts } from '../application/ports/isolationMechanics'
import { recoverMergesBeforeScope } from '../engine/kernel/mergeRecovery'
import { resolveMergeConflicts } from '../engine/node/shared/resolveMergeConflicts'
import { bindIsolationCleanup } from '../infrastructure/executionKernelBinding'
import { restoredSubmodules } from '../infrastructure/executionWorkspaceSession'
import { completeIsolatedHumanConflict } from '../infrastructure/isolationWorkspaceView'
import { isolatedRunBinding } from './executionMechanismBindings'
import { workspaceSessionFor } from './executionWorkspaceBinding'
import { bindMergeConflictPorts } from './mergeConflictResolution'
import type { TaskMechanicsState } from './taskMechanicsState'
import type { Logger } from '@/util/log'

export function createIsolationMechanicsPorts(state: TaskMechanicsState): IsolationMechanicsPorts {
  return {
    get taskId() {
      return state.taskId
    },
    get appHome() {
      return state.opts.appHome
    },
    get repos() {
      return state.repos
    },
    get execution() {
      return state.opts.executionContext
    },
    get writeSem() {
      return state.writeSem
    },
    get log() {
      return state.log
    },
    get binding() {
      return isolatedRunBinding(state)
    },
    get cleanup() {
      return bindIsolationCleanup()
    },
    persistence: {
      get nodeExecution() {
        return state.opts.persistence.nodeExecution
      },
      get mergeStates() {
        return state.opts.persistence.mergeStates
      },
      get artifactPaths() {
        return state.opts.persistence.artifactPaths
      },
    },
    workspace: {
      scope: () => workspaceSessionFor(state).scope(),
      restore: ({ submodules, ...request }) =>
        workspaceSessionFor(state).restore({
          ...request,
          ...(submodules === undefined ? {} : { submodules: restoredSubmodules(submodules) }),
        }),
    },
    conflicts: {
      resolveMergeConflicts: (input) => resolveMergeConflicts(bindMergeConflictPorts(state), input),
    },
    completeHumanConflict: (handle, nodeTrees, log) =>
      completeIsolatedHumanConflict(handle, nodeTrees, log),
  }
}

export function composeExecutionMergeRecovery(
  state: TaskMechanicsState,
  log: Logger,
): ExecutionMergeRecovery {
  return {
    recoverBeforeScope: () => recoverMergesBeforeScope(createIsolationMechanicsPorts(state), log),
  }
}
