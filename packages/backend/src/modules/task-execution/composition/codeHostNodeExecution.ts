import type { TaskMechanicsState } from '@/services/execution/taskMechanicsState'
import { executeCodeHostCall } from '@/services/codeHost/call'
import { resolveProjectFallback } from '@/services/codeHost/project'
import { probeCodeHostMutation } from '@/services/codeHost/recoveryProbe'
import type { CodeHostNodeExecutionPorts } from '../application/ports/codeHostNodeExecution'
import type { TaskExecutionContext } from '../application/taskExecutionContext'
import { createCodeHostEffectAttemptObserver } from '../application/codeHostEffectObserver'
import { resolveSchedulerRunRow } from '../application/resolveSchedulerRunRow'
import { resolveUpstreamInputs } from '../application/nodeInputs'
import { prepareConsumedInputs } from '../infrastructure/consumedInputsParticipant'
import { broadcastNodeStatus } from '../infrastructure/nodeStatusEvents'
import { nodeRunLedger } from './executionMechanismBindings'

type CodeHostNodeExecutionBinding = Pick<
  TaskMechanicsState,
  'taskId' | 'definition' | 'containerOf' | 'triggerContext' | 'codeHostSem' | 'log'
> & {
  readonly task: Pick<
    TaskMechanicsState['task'],
    'workflowVersion' | 'executionLineageId' | 'repoUrl' | 'repoCount'
  >
  readonly opts: Pick<
    TaskMechanicsState['opts'],
    | 'executionContext'
    | 'codeHostConnections'
    | 'codeHostRequestTimeoutMs'
    | 'codeHostResponseMaxBytes'
    | 'codeHostFetch'
  > & {
    readonly persistence: Pick<
      TaskMechanicsState['opts']['persistence'],
      'nodeRuns' | 'nodeExecution' | 'selection' | 'effects'
    >
  }
}

/** Only adapters and context binding. The send/probe decision loop lives in the executor. */
export function createCodeHostNodeExecutionPorts(
  state: CodeHostNodeExecutionBinding,
): CodeHostNodeExecutionPorts {
  return {
    task: {
      get taskId() {
        return state.taskId
      },
      get workflowVersion() {
        return state.task.workflowVersion
      },
      get executionLineageId() {
        return state.task.executionLineageId
      },
      get repoUrl() {
        return state.task.repoUrl
      },
      get repoCount() {
        return state.task.repoCount
      },
      get triggerContext() {
        return state.triggerContext
      },
    },
    policy: {
      get codeHostConnections() {
        return state.opts.codeHostConnections
      },
      get codeHostRequestTimeoutMs() {
        return state.opts.codeHostRequestTimeoutMs
      },
      get codeHostResponseMaxBytes() {
        return state.opts.codeHostResponseMaxBytes
      },
      get codeHostFetch() {
        return state.opts.codeHostFetch
      },
    },
    get codeHostSem() {
      return state.codeHostSem
    },
    input: {
      resolveUpstreamInputs: (nodeId, frame) =>
        resolveUpstreamInputs(
          state.opts.persistence.nodeExecution,
          state.taskId,
          state.definition.edges,
          nodeId,
          frame,
          state.log,
          state.definition,
          state.containerOf,
        ),
      prepareConsumedInputs: (record) =>
        prepareConsumedInputs({ record }).consumedUpstreamRunsJson!,
    },
    ledger: {
      listNodeRuns: (input) => state.opts.persistence.nodeExecution.list(input),
      read: (id) => state.opts.persistence.nodeExecution.read(id),
      resolveSchedulerRunRow: (input) =>
        resolveSchedulerRunRow({
          lifecycle: state.opts.persistence.nodeRuns,
          projections: state.opts.persistence.nodeExecution,
          ...nodeRunLedger(state).executionContextInput(),
          ...input,
          selection: state.opts.persistence.selection,
        }),
      setNodeRunStatus: (input) => nodeRunLedger(state).setNodeRunStatus(input),
      upsertOutputs: (input) =>
        state.opts.persistence.nodeExecution.upsertOutputs({
          ...input,
          ...nodeRunLedger(state).executionContextInput(),
        }),
    },
    effects: {
      get enabled() {
        return state.opts.executionContext !== undefined
      },
      planCodeHostAttempt: (input) => state.opts.persistence.effects.planCodeHostAttempt(input),
      createCodeHostEffectAttemptObserver: (input) =>
        createCodeHostEffectAttemptObserver({
          ...input,
          persistence: state.opts.persistence.effects,
          context: state.opts.executionContext as TaskExecutionContext,
        }),
    },
    requests: { executeCodeHostCall, resolveProjectFallback, probeCodeHostMutation },
    status: { broadcastNodeStatus },
  }
}
