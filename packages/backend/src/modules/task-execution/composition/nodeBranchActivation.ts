import type { TaskMechanicsState } from './taskMechanicsState'
import type { NodeBranchActivationPorts } from '../application/nodeBranchActivation'
import { nodeRunMintIdentityForSlot } from '../application/nodeRunMintIdentity'
import { prepareConsumedInputs } from '../infrastructure/consumedInputsParticipant'
import { broadcastNodeStatus } from '../infrastructure/nodeStatusEvents'
import { nodeRunLedger } from './executionMechanismBindings'

export function createNodeBranchActivationPorts(
  state: TaskMechanicsState,
): NodeBranchActivationPorts {
  return {
    get taskId() {
      return state.taskId
    },
    get definition() {
      return state.definition
    },
    get containerOf() {
      return state.containerOf
    },
    get log() {
      return state.log
    },
    get rows() {
      return state.opts.persistence.nodeExecution
    },
    get activation() {
      return state.opts.persistence.nodeActivation
    },
    prepareConsumedInputs: (record) => prepareConsumedInputs({ record }).consumedUpstreamRunsJson!,
    ledger: {
      nodeRunMintIdentityForSlot,
      mintNodeRun: (input) => nodeRunLedger(state).mintNodeRun(input),
      transitionNodeRunStatus: (input) => nodeRunLedger(state).transitionNodeRunStatus(input),
    },
    patch: (input) =>
      state.opts.persistence.nodeExecution.patch({
        ...input,
        ...nodeRunLedger(state).executionContextInput(),
      }),
    status: { broadcastNodeStatus },
  }
}
