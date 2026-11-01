import type { TaskMechanicsState } from './taskMechanicsState'
import { copyPortArchive } from '@/platform/content/locations/portArchive'
import type {
  InputNodeExecutionPorts,
  OutputNodeExecutionPorts,
} from '../application/ports/virtualIoNodeExecution'
import { nodeRunMintIdentityForSlot } from '../application/nodeRunMintIdentity'
import { readPortRowAtFrame } from '../application/nodeInputs'
import { prepareConsumedInputs } from '../infrastructure/consumedInputsParticipant'
import { broadcastNodeStatus } from '../infrastructure/nodeStatusEvents'
import { nodeRunLedger } from './executionMechanismBindings'

export function createInputNodeExecutionPorts(state: TaskMechanicsState): InputNodeExecutionPorts {
  return {
    get taskId() {
      return state.taskId
    },
    get inputsMap() {
      return state.inputsMap
    },
    ledger: {
      nodeRunMintIdentityForSlot,
      mintNodeRun: (input) => nodeRunLedger(state).mintNodeRun(input),
    },
    status: { broadcastNodeStatus },
  }
}
export function createOutputNodeExecutionPorts(
  state: TaskMechanicsState,
): OutputNodeExecutionPorts {
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
    input: {
      read: (id) => state.opts.persistence.nodeExecution.read(id),
      readPortRowAtFrame: (...args) =>
        readPortRowAtFrame(state.opts.persistence.nodeExecution, ...args),
      prepareConsumedInputs: (record) =>
        prepareConsumedInputs({ record }).consumedUpstreamRunsJson!,
      copyPortArchive,
    },
    ledger: {
      nodeRunMintIdentityForSlot,
      mintNodeRun: (input) => nodeRunLedger(state).mintNodeRun(input),
    },
    status: { broadcastNodeStatus },
  }
}
