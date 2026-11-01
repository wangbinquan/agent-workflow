import type { TaskMechanicsState } from './taskMechanicsState'
import { extractScriptPorts } from '@/services/scriptPorts'
import type { ScriptNodeExecutionPorts } from '../application/ports/scriptNodeExecution'
import { resolveUpstreamInputs } from '../application/nodeInputs'
import { resolveSchedulerRunRow } from '../application/resolveSchedulerRunRow'
import { nodeRunMintIdentityForSlot } from '../application/nodeRunMintIdentity'
import { createProcessEffectAttemptObserver } from '../application/processEffectObserver'
import { prepareConsumedInputs } from '../infrastructure/consumedInputsParticipant'
import { broadcastNodeStatus } from '../infrastructure/nodeStatusEvents'
import { describeIsoFailure } from '../infrastructure/executionDiagnostics'
import { bindIsolationCleanup } from '../infrastructure/executionKernelBinding'
import { createIsoUnderLock, persistIsoBase } from '../engine/kernel/isolation'
import { mergeBackAndSettle, markMergeFailed } from '../engine/kernel/merge'
import { discardNodeIso } from '../engine/kernel/isolationCleanup'
import { resolveMergeConflicts } from '../engine/node/shared/resolveMergeConflicts'
import { bindMergeConflictPorts } from './mergeConflictResolution'
import { isolatedRunBinding, nodeRunLedger } from './executionMechanismBindings'

/** Each gateway receives capabilities without selecting runtimes, workspaces or receipts early. */
export function createScriptNodeExecutionPorts(
  state: TaskMechanicsState,
): ScriptNodeExecutionPorts {
  return {
    policy: {
      get appHome() {
        return state.opts.appHome
      },
      get defaultNodeRetries() {
        return state.opts.defaultNodeRetries
      },
      get defaultPerNodeTimeoutMs() {
        return state.opts.defaultPerNodeTimeoutMs
      },
      get scriptDepsInstallTimeoutMs() {
        return state.opts.scriptDepsInstallTimeoutMs
      },
      get scriptInterpreters() {
        return state.opts.scriptInterpreters
      },
    },
    task: {
      get taskId() {
        return state.taskId
      },
      get gitUserName() {
        return state.task.gitUserName
      },
      get gitUserEmail() {
        return state.task.gitUserEmail
      },
      get scopeRoot() {
        return state.scopeRoot
      },
      get repos() {
        return state.repos
      },
    },
    get log() {
      return state.log
    },
    get scriptSem() {
      return state.scriptSem
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
      nodeRunMintIdentityForSlot,
      executionContextInput: () => nodeRunLedger(state).executionContextInput(),
      mintNodeRun: (input) => nodeRunLedger(state).mintNodeRun(input),
      setNodeRunStatus: (input) => nodeRunLedger(state).setNodeRunStatus(input),
      transitionNodeRunStatus: (input) => nodeRunLedger(state).transitionNodeRunStatus(input),
      loadEnvelopeNonce: (id) => nodeRunLedger(state).loadEnvelopeNonce(id),
      listNodeRuns: (input) => state.opts.persistence.nodeExecution.list(input),
      resolveSchedulerRunRow: (input) =>
        resolveSchedulerRunRow({
          lifecycle: state.opts.persistence.nodeRuns,
          projections: state.opts.persistence.nodeExecution,
          ...nodeRunLedger(state).executionContextInput(),
          ...input,
          selection: state.opts.persistence.selection,
        }),
      appendEvent: (input) =>
        state.opts.persistence.nodeExecution.appendEvent({
          ...input,
          ...nodeRunLedger(state).executionContextInput(),
        }),
      upsertOutputs: (input) =>
        state.opts.persistence.nodeExecution.upsertOutputs({
          ...input,
          ...nodeRunLedger(state).executionContextInput(),
        }),
    },
    workspace: {
      createIsoUnderLock: (isoKeyRunId) =>
        createIsoUnderLock({
          writeSem: state.writeSem,
          appHome: state.opts.appHome,
          taskId: state.taskId,
          binding: isolatedRunBinding(state),
          isoKeyRunId,
          canonRepos: state.repos,
          log: state.log,
        }),
      persistIsoBase: (nodeRunId, handle) =>
        persistIsoBase(isolatedRunBinding(state), nodeRunId, handle),
      mergeBackAndSettle: (input) =>
        mergeBackAndSettle({
          binding: isolatedRunBinding(state),
          writeSem: state.writeSem,
          ...input,
          log: state.log,
        }),
      markMergeFailed: (nodeRunId, message) =>
        markMergeFailed(isolatedRunBinding(state), nodeRunId, message, state.log),
      discardNodeIso: (handle) =>
        discardNodeIso(bindIsolationCleanup(), handle, state.log, state.writeSem),
      transitionMergeState: (input) =>
        state.opts.persistence.mergeStates.transition({
          ...input,
          ...nodeRunLedger(state).executionContextInput(),
        }),
    },
    process: {
      resolveInterpreter: (...args) => state.opts.taskScriptRuns.resolveInterpreter(...args),
      describeInterpreterResolution: (...args) =>
        state.opts.taskScriptRuns.describeInterpreterResolution(...args),
      prepareRunContent: (...args) => state.opts.taskScriptRuns.prepareRunContent(...args),
      dependencyInterpreter: (...args) => state.opts.taskScriptRuns.dependencyInterpreter(...args),
      ensureDependencies: (input) => state.opts.taskScriptRuns.ensureDependencies(input),
      runScriptProcess: (input) => state.opts.taskScriptRuns.execute(input),
      runtimeParameters: (input) => state.opts.taskScriptRuns.runtimeParameters(input),
      recordUnownedStart: (input) =>
        state.opts.taskScriptRuns.recordUnownedStart({
          persistence: state.opts.persistence.nodeExecution,
          ...input,
          executionContext: () => nodeRunLedger(state).executionContextInput(),
        }),
    },
    effect: {
      createProcessEffectAttemptObserver: (input) => {
        const persistence = state.opts.persistence.effects
        return createProcessEffectAttemptObserver({
          persistence,
          taskId: input.taskId,
          nodeRunId: input.nodeRunId,
          processKind: 'script',
          resourceKeys: (description) => description.resourceKeys,
          projection: input.start.project(persistence, input.resources),
        })
      },
    },
    output: { extractScriptPorts },
    status: { broadcastNodeStatus },
    diagnostics: { describeIsoFailure },
    conflicts: {
      resolveMergeConflicts: (input) => resolveMergeConflicts(bindMergeConflictPorts(state), input),
    },
  }
}
