import { ulid } from 'ulid'
import { copyPortArchive } from '@/platform/content/locations/portArchive'
import {
  currentMaxInvocationDepth,
  ensureChildTaskBudget,
  registerKnownChildTask,
} from '../infrastructure/childBudget'
import { watchTaskTerminal } from '../infrastructure/executionWatch'
import { getExecutionOutcome } from '@/services/execution/outcome'
import type { TaskMechanicsState } from './taskMechanicsState'
import type { ChildCallNodeExecutionPorts } from '../application/ports/childCallNodeExecution'
import { buildChildRuntime, delegatedCallActor } from '../application/childCallInheritance'
import { resolveUpstreamInputs } from '../application/nodeInputs'
import { resolveSchedulerRunRow } from '../application/resolveSchedulerRunRow'
import { definitionAnchorId } from '../domain/taskSubject'
import { createIsoUnderLock, persistIsoBase } from '../engine/kernel/isolation'
import { discardNodeIso } from '../engine/kernel/isolationCleanup'
import { markMergeFailed, mergeBackAndSettle } from '../engine/kernel/merge'
import { restoreNodeIso } from '../engine/kernel/mergeRecovery'
import { resolveMergeConflicts } from '../engine/node/shared/resolveMergeConflicts'
import { prepareConsumedInputs } from '../infrastructure/consumedInputsParticipant'
import { bindIsolationCleanup } from '../infrastructure/executionKernelBinding'
import {
  childClosureSubset,
  frozenWorkflowFromClosure,
  frozenWorkgroupFromClosure,
} from '@/modules/resource-catalog/public/queries'
import { broadcastNodeStatus } from '../infrastructure/nodeStatusEvents'
import { isolatedRunBinding, nodeRunLedger } from './executionMechanismBindings'
import { createIsolationMechanicsPorts } from './isolationMechanicsBinding'
import { bindMergeConflictPorts } from './mergeConflictResolution'

/** RFC-404 — capabilities of the call-workflow / call-workgroup body; every value is read on use. */
export function createChildCallNodeExecutionPorts(
  state: TaskMechanicsState,
): ChildCallNodeExecutionPorts {
  return {
    task: {
      get taskId() {
        return state.taskId
      },
      get name() {
        return state.task.name
      },
      get workflowAnchorId() {
        return definitionAnchorId(state.task.subject)
      },
      get refClosureJson() {
        return state.task.refClosureJson ?? null
      },
      get invocationDepth() {
        return state.task.invocationDepth ?? 0
      },
      get parentTaskId() {
        return state.task.parentTaskId ?? null
      },
      get ownerUserId() {
        return state.task.ownerUserId
      },
      get worktreePath() {
        return state.task.worktreePath
      },
      get branch() {
        return state.task.branch
      },
      get repos() {
        return state.repos
      },
      get collaboratorUserIds() {
        return state.collaboratorUserIds
      },
      get triggerContext() {
        return state.triggerContext
      },
    },
    policy: {
      get signal() {
        return state.opts.signal
      },
    },
    get log() {
      return state.log
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
      copyPortArchive,
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
      setNodeRunStatus: (input) => nodeRunLedger(state).setNodeRunStatus(input),
      transitionNodeRunStatus: (input) => nodeRunLedger(state).transitionNodeRunStatus(input),
      upsertOutputs: (input) =>
        state.opts.persistence.nodeExecution.upsertOutputs({
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
    closure: {
      frozenWorkflow: (refClosureJson, name, source) =>
        frozenWorkflowFromClosure(refClosureJson, name, source),
      frozenWorkgroup: (refClosureJson, name, source) =>
        frozenWorkgroupFromClosure(refClosureJson, name, source),
      childClosureSubset: (refClosureJson, childDefinition, childWorkflowId) =>
        childClosureSubset(refClosureJson, childDefinition, childWorkflowId),
    },
    budget: {
      maxInvocationDepth: () => currentMaxInvocationDepth(state.opts.maxInvocationDepth),
      ensureBudget: () =>
        ensureChildTaskBudget(
          state.opts.persistence.childBudget,
          () => state.opts.maxActiveChildTasks ?? 8,
        ),
      parentTaskId: (taskId) => state.opts.persistence.childBudget.parentTaskId(taskId),
      registerKnownChildTask,
    },
    children: {
      newChildTaskId: () => ulid(),
      // RFC-420: the delegated owner actor and the child runtime are application/childCallInheritance.ts.
      resolveActor: (kind, parentNodeRunId) =>
        delegatedCallActor(state.opts.identityAccess.delegatedRequests, {
          kind,
          ownerUserId: state.task.ownerUserId,
          parentTaskId: state.taskId,
          parentNodeRunId,
        }),
      launchWorkflow: (request) =>
        state.opts.childLaunch.launchWorkflow({
          ...request,
          runtime: buildChildRuntime(state),
          schedulerDriver: state.topology.schedulerDriver,
        }),
      launchWorkgroup: (request) =>
        state.opts.childLaunch.launchWorkgroup({
          ...request,
          runtime: buildChildRuntime(state),
          schedulerDriver: state.topology.schedulerDriver,
        }),
      resumeChild: async (childTaskId) => {
        // RFC-285 B3 Q6: a resume continues the existing child row — no owner rebuild or re-check.
        const childRuntime = buildChildRuntime(state)
        await state.topology.schedulerDriver.resumeChild({
          taskId: childTaskId,
          runtime: childRuntime,
        })
      },
      cancelChild: async (childTaskId) => {
        await state.topology.schedulerDriver.cancelChild({
          taskId: childTaskId,
          cause: { kind: 'parent-cascade', parentTaskId: state.task.id },
        })
      },
      isTaskActive: (childTaskId) => state.topology.schedulerDriver.isTaskActive(childTaskId),
      findStatus: (childTaskId) => state.opts.persistence.reads.statusProjection.find(childTaskId),
      watchTerminal: (childTaskId, opts) =>
        watchTaskTerminal(state.opts.persistence.reads.statusProjection, childTaskId, opts),
      outcome: (childTaskId) =>
        getExecutionOutcome(state.opts.persistence.reads.executionOutcome, childTaskId),
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
      // RFC-420: the replay idiom's rebuild is the kernel's, on the isolation ports over this state.
      restoreIso: (input) => restoreNodeIso(createIsolationMechanicsPorts(state), input),
    },
    conflicts: {
      resolveMergeConflicts: (input) => resolveMergeConflicts(bindMergeConflictPorts(state), input),
    },
    status: { broadcastNodeStatus },
  }
}
