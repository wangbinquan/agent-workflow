import { portFallbackMount } from '@/platform/content/locations/portArchive'
import { findClarifyNode } from '@/services/clarify/service'
import {
  computeRemaining,
  resolveEffectiveClarifyChannel,
  shouldInjectStopNotice,
} from '@/services/clarifyRounds'
import { parsePortValidationFailuresJson } from '@/services/envelope'
import type { TaskMechanicsState } from '@/services/execution/taskMechanicsState'
import { continuesClarifyLineage, isClarifyRerunCause } from '@/services/nodeRunMint'
import { agentRefOfNode } from '@/services/ref/runtimeRef'
import { getRuntimeDriver } from '@/services/runtime'
import { decideResumeSessionId } from '@/services/sessionModeFallback'
import * as agentRunHistory from '../application/agentRunHistory'
import { resolveUpstreamInputs } from '../application/nodeInputs'
import { toContainerRelative } from '../application/portArtifacts'
import type {
  AgentNodeExecutionPorts,
  AgentRunRequest,
} from '../application/ports/agentNodeExecution'
import { NOOP_AGENT_RUN_SETTLED_OBSERVER } from '../application/ports/agentRunSettledObserver'
import type { TaskAgentRunPolicy } from '../application/ports/taskAgentRun'
import { resolveSchedulerRunRow } from '../application/resolveSchedulerRunRow'
import { createIsoUnderLock, persistIsoBase } from '../engine/kernel/isolation'
import { discardNodeIso } from '../engine/kernel/isolationCleanup'
import { markMergeFailed, mergeBackAndSettle } from '../engine/kernel/merge'
import { resolveMergeConflicts } from '../engine/node/shared/resolveMergeConflicts'
import { prepareConsumedInputs } from '../infrastructure/consumedInputsParticipant'
import { describeIsoFailure } from '../infrastructure/executionDiagnostics'
import { bindIsolationCleanup } from '../infrastructure/executionKernelBinding'
import { broadcastNodeStatus } from '../infrastructure/nodeStatusEvents'
import { isolatedRunBinding, nodeRunLedger } from './executionMechanismBindings'
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

/** RFC-405 — capabilities of the agent-single body; every value is read on use. */
export function createAgentNodeExecutionPorts(state: TaskMechanicsState): AgentNodeExecutionPorts {
  const persistence = () => state.opts.persistence.nodeExecution
  const collaboration = () => state.opts.collaborationRuntime
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
    resources: {
      injection: (agentId) => state.taskExecutionResources.injection(agentId),
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
      transitionNodeRunStatus: (input) => nodeRunLedger(state).transitionNodeRunStatus(input),
      loadEnvelopeNonce: (id) => nodeRunLedger(state).loadEnvelopeNonce(id),
      appendEvent: (input) =>
        state.opts.persistence.nodeExecution.appendEvent({
          ...input,
          ...nodeRunLedger(state).executionContextInput(),
        }),
      read: (nodeRunId) => state.opts.persistence.nodeExecution.read(nodeRunId),
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
