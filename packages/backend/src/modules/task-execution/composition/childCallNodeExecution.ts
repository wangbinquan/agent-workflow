import { ulid } from 'ulid'
import type { Permission } from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import { copyPortArchive } from '@/platform/content/locations/portArchive'
import {
  currentMaxInvocationDepth,
  ensureChildTaskBudget,
  registerKnownChildTask,
} from '@/services/execution/childBudget'
import { watchTaskTerminal } from '@/services/execution/executionWatch'
import { getExecutionOutcome } from '@/services/execution/outcome'
import type { TaskMechanicsState } from '@/services/execution/taskMechanicsState'
import type { ChildCallNodeExecutionPorts } from '../application/ports/childCallNodeExecution'
import { pickInheritableRunConfig } from '../application/ports/taskExecutionTopology'
import { resolveUpstreamInputs } from '../application/nodeInputs'
import { resolveSchedulerRunRow } from '../application/resolveSchedulerRunRow'
import { parseIsoSubmodules } from '../domain/isoSubmodules'
import { definitionAnchorId } from '../domain/taskSubject'
import { createIsoUnderLock, persistIsoBase } from '../engine/kernel/isolation'
import { discardNodeIso } from '../engine/kernel/isolationCleanup'
import { markMergeFailed, mergeBackAndSettle } from '../engine/kernel/merge'
import { resolveMergeConflicts } from '../engine/node/shared/resolveMergeConflicts'
import { prepareConsumedInputs } from '../infrastructure/consumedInputsParticipant'
import { bindIsolationCleanup } from '../infrastructure/executionKernelBinding'
import { restoredSubmodules } from '../infrastructure/executionWorkspaceSession'
import {
  childClosureSubset,
  frozenWorkflowFromClosure,
  frozenWorkgroupFromClosure,
} from '../infrastructure/legacyCallClosure'
import { broadcastNodeStatus } from '../infrastructure/nodeStatusEvents'
import { workspaceSessionFor } from './executionWorkspaceBinding'
import { isolatedRunBinding, nodeRunLedger } from './executionMechanismBindings'
import { bindMergeConflictPorts } from './mergeConflictResolution'

/** D6/Q5 compatibility: a historical NULL owner is deliberately not the
 * literal system account and therefore carries no permissions. */
const OWNERLESS_SYSTEM_USER_ID = '__system__'
const OWNERLESS_LEGACY_ACTOR: Actor = Object.freeze({
  user: Object.freeze({
    id: OWNERLESS_SYSTEM_USER_ID,
    username: OWNERLESS_SYSTEM_USER_ID,
    displayName: OWNERLESS_SYSTEM_USER_ID,
    role: 'user',
    status: 'active',
  }),
  source: 'daemon',
  permissions: new Set<Permission>(),
  authorityRevision: 0,
})

async function delegatedCallActor(
  state: TaskMechanicsState,
  kind: 'call-workflow' | 'call-workgroup',
  ownerUserId: string | null,
  parentNodeRunId: string,
): Promise<Actor | null> {
  if (ownerUserId === null) return OWNERLESS_LEGACY_ACTOR
  const delegated = state.opts.identityAccess.delegatedRequests
  const admission = await delegated.forCall({
    kind,
    ownerUserId,
    parentTaskId: state.taskId,
    parentNodeRunId,
  })
  return admission?.actor ?? null
}

/** RFC-284 T20 / RFC-331 — the one child runtime: both launch arms and the child resume use it. */
function buildChildRuntime(state: TaskMechanicsState) {
  return {
    ...(state.triggerContext === null ? {} : { triggerContext: state.triggerContext }),
    actorUserId:
      (state.task as unknown as { ownerUserId?: string | null }).ownerUserId ?? undefined,
    runConfig: pickInheritableRunConfig(state.opts),
  }
}

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
      resolveActor: (kind, parentNodeRunId) =>
        delegatedCallActor(state, kind, state.task.ownerUserId, parentNodeRunId),
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
      restoreIso: async ({ nodeRunId, workspaceRef, baseSnapshots, checkpoints }) => {
        // Same order as the replay idiom: scope, every task repo HEAD, the recovery key, then restore.
        const scope = await workspaceSessionFor(state).scope()
        const taskBaseHeads: Record<string, string> = {}
        for (const repo of state.repos) {
          const h = await scope.head(repo.worktreePath)
          taskBaseHeads[repo.mountPath] = h.stdout.trim()
        }
        const submodules = parseIsoSubmodules(checkpoints)
        return await workspaceSessionFor(state).restore({
          key: await scope.recoverKey(workspaceRef, nodeRunId),
          dbNodeRunId: nodeRunId,
          workspaceRef,
          baseSnapshots,
          taskBaseHeads,
          submodules: restoredSubmodules(submodules),
          forcedContainerPaths: [
            ...(await state.opts.persistence.artifactPaths.forcedPaths(state.taskId)),
          ],
        })
      },
    },
    conflicts: {
      resolveMergeConflicts: (input) => resolveMergeConflicts(bindMergeConflictPorts(state), input),
    },
    status: { broadcastNodeStatus },
  }
}
