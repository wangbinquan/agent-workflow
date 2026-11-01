import { workspaceSessionFor } from './executionWorkspaceBinding'
import type { TaskMechanicsState } from '@/services/execution/taskMechanicsState'
import type { IsolatedAgentRunBinding } from '../application/ports/executionKernel'
import { bindNodeRunLedger } from '../engine/kernel/nodeRunLedger'
import { bindIsolationKernel } from '../infrastructure/executionKernelBinding'
import { createIsolationWorkspacePort } from '../infrastructure/isolationWorkspaceView'

export function nodeRunLedger(state: {
  readonly opts: {
    readonly persistence: Pick<TaskMechanicsState['opts']['persistence'], 'nodeRuns'>
    readonly executionContext?: TaskMechanicsState['opts']['executionContext']
  }
}) {
  return bindNodeRunLedger(state.opts.persistence.nodeRuns, state.opts.executionContext)
}

export function isolatedRunBinding(state: TaskMechanicsState): IsolatedAgentRunBinding {
  return bindIsolationKernel({
    workspace: createIsolationWorkspacePort(() => workspaceSessionFor(state).scope()),
    artifactPaths: state.opts.persistence.artifactPaths,
    mergeStates: state.opts.persistence.mergeStates,
    nodeExecution: state.opts.persistence.nodeExecution,
    effects: state.opts.persistence.effects,
    ...nodeRunLedger(state).executionContextInput(),
  })
}
