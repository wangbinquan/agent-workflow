import type { TaskMechanicsState } from './taskMechanicsState'
import { portFallbackMount } from '@/platform/content/locations/portArchive'
import type {
  ReviewNodeExecutionPorts,
  ClarifyNodeExecutionPorts,
  CrossClarifyNodeExecutionPorts,
} from '../application/ports/humanGateNodeExecution'
import { nodeRunMintIdentityForSlot } from '../application/nodeRunMintIdentity'
import { recordSkippedRun } from '../application/nodeBranchActivation'
import { settleIdleClarify } from '../engine/node/clarify/settleIdleClarify'
import { broadcastNodeStatus } from '../infrastructure/nodeStatusEvents'
import { nodeRunLedger } from './executionMechanismBindings'
import { createNodeBranchActivationPorts } from './nodeBranchActivation'

export function createReviewNodeExecutionPorts(
  state: Pick<TaskMechanicsState, 'taskId' | 'definition' | 'scopeRoot'> & {
    readonly repos: readonly { readonly mountPath: string }[]
    readonly opts: Pick<
      TaskMechanicsState['opts'],
      'appHome' | 'executionContext' | 'collaborationRuntime'
    >
  },
): ReviewNodeExecutionPorts {
  return {
    get taskId() {
      return state.taskId
    },
    get appHome() {
      return state.opts.appHome
    },
    get definition() {
      return state.definition
    },
    get scopeRoot() {
      return state.scopeRoot
    },
    get repoMounts() {
      return state.repos.map((repo) => repo.mountPath)
    },
    portFallbackMount,
    dispatchReviewNode: (input) =>
      state.opts.collaborationRuntime.dispatchReviewNode({
        ...input,
        ...(state.opts.executionContext === undefined
          ? {}
          : { executionContext: state.opts.executionContext }),
      }),
  }
}
export function createClarifyNodeExecutionPorts(
  state: TaskMechanicsState,
): ClarifyNodeExecutionPorts {
  const branch = createNodeBranchActivationPorts(state)
  return {
    get taskId() {
      return state.taskId
    },
    get log() {
      return state.log
    },
    get rows() {
      return state.opts.persistence.nodeExecution
    },
    get selection() {
      return state.opts.persistence.selection
    },
    recordSkippedRun: (input) => recordSkippedRun(branch, input),
  }
}
export function createCrossClarifyNodeExecutionPorts(
  state: TaskMechanicsState,
): CrossClarifyNodeExecutionPorts {
  const idle = createClarifyNodeExecutionPorts(state)
  return {
    get taskId() {
      return state.taskId
    },
    get definition() {
      return state.definition
    },
    get rows() {
      return state.opts.persistence.nodeExecution
    },
    ledger: {
      nodeRunMintIdentityForSlot,
      mintNodeRun: (input) => nodeRunLedger(state).mintNodeRun(input),
      setNodeRunStatus: (input) => nodeRunLedger(state).setNodeRunStatus(input),
    },
    status: { broadcastNodeStatus },
    getNodeClarifyDirective: (input) =>
      state.opts.collaborationRuntime.getNodeClarifyDirective(input),
    inspectCrossClarify: (input) =>
      state.opts.collaborationRuntime.inspectCrossClarify({
        ...input,
        ...(state.opts.executionContext === undefined
          ? {}
          : { executionContext: state.opts.executionContext }),
      }),
    settleIdleClarify: (request) => settleIdleClarify(idle, request),
  }
}
