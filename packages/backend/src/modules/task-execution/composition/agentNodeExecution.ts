import { portFallbackMount } from '@/platform/content/locations/portArchive'
import {
  computeRemaining,
  findClarifyNode,
  resolveEffectiveClarifyChannel,
  shouldInjectStopNotice,
} from '../domain/clarifyRules'
import { CLARIFY_FORBIDDEN_PREFIX, parsePortValidationFailuresJson } from '@/services/envelope'
import { resolveSyntheticTaskAgentInjection } from '@/services/execution/taskExecutionResources'
import type { TaskMechanicsState } from './taskMechanicsState'
import { continuesClarifyLineage, isClarifyRerunCause } from '@/services/nodeRunMint'
import { agentRefOfNode, fanoutInnerAgentRefKey } from '@/services/ref/runtimeRef'
import { getRuntimeDriver } from '@/services/runtime'
import { sha256Hex } from '@/util/hash'
import { decideResumeSessionId } from '@/services/sessionModeFallback'
import * as agentRunHistory from '../application/agentRunHistory'
import { resolveUpstreamInputs } from '../application/nodeInputs'
import { toContainerRelative } from '../application/portArtifacts'
import { sourcePortKindOf, type FanoutAgentResources } from '../application/fanoutAgentResolution'
import type {
  AgentNodeExecutionPorts,
  AgentRunRequest,
} from '../application/ports/agentNodeExecution'
import { NOOP_AGENT_RUN_SETTLED_OBSERVER } from '../application/ports/agentRunSettledObserver'
import type { CollaborationNodeGatePort } from '../application/ports/collaborationNodeGate'
import type { TaskAgentRunPolicy } from '../application/ports/taskAgentRun'
import { resolveSchedulerRunRow } from '../application/resolveSchedulerRunRow'
import { ORCHESTRATOR_AGENT_ID } from '../domain/orchestratorAgentIdentity'
import { createIsoUnderLock, persistIsoBase } from '../engine/kernel/isolation'
import { discardNodeIso } from '../engine/kernel/isolationCleanup'
import { markMergeFailed, mergeBackAndSettle } from '../engine/kernel/merge'
import { resolveMergeConflicts } from '../engine/node/shared/resolveMergeConflicts'
import { prepareConsumedInputs } from '../infrastructure/consumedInputsParticipant'
import { describeIsoFailure } from '../infrastructure/executionDiagnostics'
import { workspaceRecord } from '../infrastructure/isolationWorkspaceView'
import { bindIsolationCleanup } from '../infrastructure/executionKernelBinding'
import { broadcastNodeStatus } from '../infrastructure/nodeStatusEvents'
import { isolatedRunBinding, nodeRunLedger } from './executionMechanismBindings'
import { completeInterruptedMerge } from '../engine/kernel/mergeRecovery'
import { createIsolationMechanicsPorts } from './isolationMechanicsBinding'
import { bindMergeConflictPorts } from './mergeConflictResolution'
import { runTaskAgentWithFamily } from './taskAgentRunFamily'

/**
 * RFC-405 — the task-level fields of one agent run, read from the current options. The engine body
 * supplies everything else; its request is forwarded unchanged.
 */
export function withTaskRunFields(
  opts: TaskMechanicsState['opts'],
  request: AgentRunRequest,
): TaskAgentRunPolicy {
  return {
    ...request,
    observationInvocations: opts.observationInvocations,
    memorySnapshots: opts.memorySnapshots,
    memoryInjectionQueries: opts.memoryInjectionQueries,
    runtimeSessionLeases: opts.runtimeSessionLeases,
    runtimeRegistry: opts.runtimeRegistry,
    persistence: opts.persistence,
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.subagentLiveCapture !== undefined
      ? { subagentLiveCapture: opts.subagentLiveCapture }
      : {}),
  }
}

/**
 * RFC-420 — the agent resolution the wrapper data binding and this binding's `resources.sourcePortKind` share
 * (application/fanoutAgentResolution.ts): the canonical fan-out key and the task's resource session, read on use.
 */
export function agentResolutionResources(state: TaskMechanicsState): FanoutAgentResources {
  return {
    get definition() {
      return state.definition
    },
    agentKey: fanoutInnerAgentRefKey,
    injection: (agentId) => state.taskExecutionResources.injection(agentId),
  }
}

/** RFC-405 / RFC-406 — capabilities of the agent-single executor's two lanes; every value is read on use. */
export function createAgentNodeExecutionPorts(state: TaskMechanicsState): AgentNodeExecutionPorts {
  const persistence = () => state.opts.persistence.nodeExecution
  // The collaboration runtime satisfies task-execution's required gate port (RFC-334 W2-C).
  const collaboration = () => state.opts.collaborationRuntime satisfies CollaborationNodeGatePort
  return {
    task: {
      get taskId() {
        return state.taskId
      },
      get definition() {
        return state.definition
      },
      get triggerContext() {
        return state.triggerContext
      },
      get repoPath() {
        return state.task.repoPath
      },
      get baseBranch() {
        return state.task.baseBranch
      },
      get worktreePath() {
        return state.task.worktreePath
      },
      get gitUserName() {
        return state.task.gitUserName
      },
      get gitUserEmail() {
        return state.task.gitUserEmail
      },
      get platformInputPathsJson() {
        return state.task.platformInputPathsJson
      },
      get repoMounts() {
        return state.repos.map((repo) => repo.mountPath)
      },
    },
    policy: {
      get appHome() {
        return state.opts.appHome
      },
      get defaultPerNodeTimeoutMs() {
        return state.opts.defaultPerNodeTimeoutMs
      },
      get defaultNodeRetries() {
        return state.opts.defaultNodeRetries
      },
      get sessionRestartBudget() {
        return state.opts.sessionRestartBudget
      },
      get defaultRuntime() {
        return state.opts.defaultRuntime
      },
    },
    get log() {
      return state.log
    },
    get agentSem() {
      return state.agentSem
    },
    get subprocessSem() {
      return state.subprocessSem
    },
    resources: {
      injection: (agentId) => state.taskExecutionResources.injection(agentId),
      hostInjection: async (agent) =>
        agent.id === ORCHESTRATOR_AGENT_ID
          ? resolveSyntheticTaskAgentInjection(agent, state.opts.taskAgentRuns.materialReferences)
          : await state.taskExecutionResources.injection(agent.id),
      sourcePortKind: (nodeId, portName) =>
        sourcePortKindOf(agentResolutionResources(state), nodeId, portName),
    },
    collaboration: {
      resolveBorrowForNode: (input) => collaboration().resolveBorrowForNode(input),
      buildReviewPromptContext: (input) => collaboration().buildReviewPromptContext(input),
      getNodeClarifyDirective: (input) => collaboration().getNodeClarifyDirective(input),
      buildClarifyQueueContext: (input) => collaboration().buildClarifyQueueContext(input),
      openAgentClarify: (request) =>
        collaboration().openAgentClarify({
          ...request,
          ...(state.opts.executionContext === undefined
            ? {}
            : { executionContext: state.opts.executionContext }),
        }),
      isTaskClarifySuppressed: (input) => collaboration().isTaskClarifySuppressed(input),
      dismissOpenClarifyParksForAutonomous: (input) =>
        collaboration().dismissOpenClarifyParksForAutonomous(input),
    },
    rules: {
      agentRefOfNode,
      findClarifyNode,
      computeRemaining,
      resolveEffectiveClarifyChannel,
      shouldInjectStopNotice,
      parsePortValidationFailuresJson,
      isClarifyRerunCause,
      continuesClarifyLineage,
      clarifyForbiddenPrefix: CLARIFY_FORBIDDEN_PREFIX,
      shardValueHash: sha256Hex,
      decideResumeSessionId,
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
      resolveSchedulerRunRow: (input) =>
        resolveSchedulerRunRow({
          lifecycle: state.opts.persistence.nodeRuns,
          projections: state.opts.persistence.nodeExecution,
          ...nodeRunLedger(state).executionContextInput(),
          ...input,
          selection: state.opts.persistence.selection,
        }),
      mintNodeRun: (input) => nodeRunLedger(state).mintNodeRun(input),
      setNodeRunStatus: (input) => nodeRunLedger(state).setNodeRunStatus(input),
      transitionNodeRunStatus: (input) => nodeRunLedger(state).transitionNodeRunStatus(input),
      loadEnvelopeNonce: (id) => nodeRunLedger(state).loadEnvelopeNonce(id),
      appendEvent: (input) =>
        state.opts.persistence.nodeExecution.appendEvent({
          ...input,
          ...nodeRunLedger(state).executionContextInput(),
        }),
      read: (nodeRunId) => state.opts.persistence.nodeExecution.read(nodeRunId),
      listOutputs: (nodeRunId) => state.opts.persistence.nodeExecution.listOutputs(nodeRunId),
      shardSet: (taskId, wrapper) => state.opts.persistence.selection.shardSet(taskId, wrapper),
      patch: (input) =>
        state.opts.persistence.nodeExecution.patch({
          ...input,
          ...nodeRunLedger(state).executionContextInput(),
        }),
    },
    history: {
      countAgentTextEvents: (...args) =>
        agentRunHistory.countAgentTextEvents(persistence(), ...args),
      priorDoneGenerationsForRun: (...args) =>
        agentRunHistory.priorDoneGenerationsForRun(persistence(), ...args),
      lineageCausesNewestFirst: (...args) =>
        agentRunHistory.lineageCausesNewestFirst(persistence(), ...args),
      readPriorAgentSessionId: (...args) =>
        agentRunHistory.readPriorAgentSessionId(persistence(), ...args),
      freshestPriorRunWithOutput: (...args) =>
        agentRunHistory.freshestPriorRunWithOutput(persistence(), ...args),
      composePriorOutputBlock: (...args) =>
        agentRunHistory.composePriorOutputBlock(persistence(), ...args),
      readStderrText: (...args) => agentRunHistory.readStderrText(persistence(), ...args),
      recordClarifyInlineEvent: (...args) =>
        agentRunHistory.recordClarifyInlineEvent(persistence(), ...args),
    },
    runtime: {
      ofSession: (...args) => state.opts.taskAgentRuns.runtimeBindings.ofSession(...args),
      resolve: (...args) => state.opts.taskAgentRuns.runtimeBindings.resolve(...args),
      runAgent: (request, launch) => {
        const { opts } = state
        return runTaskAgentWithFamily(opts.taskAgentRuns, withTaskRunFields(opts, request), launch)
      },
      detectSessionNotFound: (protocol, stderr) =>
        getRuntimeDriver(protocol).detectSessionNotFound?.(stderr),
    },
    workspace: {
      createIsoUnderLock: (isoKeyRunId, log) =>
        createIsoUnderLock({
          writeSem: state.writeSem,
          appHome: state.opts.appHome,
          taskId: state.taskId,
          binding: isolatedRunBinding(state),
          isoKeyRunId,
          canonRepos: state.repos,
          log: log ?? state.log,
        }),
      persistIsoBase: (nodeRunId, handle) =>
        persistIsoBase(isolatedRunBinding(state), nodeRunId, handle),
      mergeBackAndSettle: (input) =>
        mergeBackAndSettle({
          binding: isolatedRunBinding(state),
          writeSem: state.writeSem,
          ...input,
          log: input.log ?? state.log,
        }),
      markMergeFailed: (nodeRunId, message, log) =>
        markMergeFailed(isolatedRunBinding(state), nodeRunId, message, log ?? state.log),
      abandonMerge: (nodeRunId, reason) =>
        state.opts.persistence.mergeStates.tryTransition({
          nodeRunId,
          event: { kind: 'abandon', reason },
          ...nodeRunLedger(state).executionContextInput(),
        }),
      discardNodeIso: (handle, log) =>
        discardNodeIso(bindIsolationCleanup(), handle, log ?? state.log, state.writeSem),
      completeInterruptedMerge: (run, log) =>
        completeInterruptedMerge(createIsolationMechanicsPorts(state), run, log),
      adoptedExecution: (handle) => workspaceRecord(handle).workspace.adoptedExecution === true,
      undoShard: (handle, input) => workspaceRecord(handle).scope.undoShard(input),
      portFileContainerPaths: (portFilePaths) =>
        portFilePaths.map((p) =>
          toContainerRelative(portFallbackMount(state.repos.map((repo) => repo.mountPath)), p),
        ),
    },
    get observer() {
      return state.opts.agentRunSettled ?? NOOP_AGENT_RUN_SETTLED_OBSERVER
    },
    status: { broadcastNodeStatus },
    diagnostics: { describeIsoFailure },
    conflicts: {
      resolveMergeConflicts: (input) => resolveMergeConflicts(bindMergeConflictPorts(state), input),
    },
  }
}
