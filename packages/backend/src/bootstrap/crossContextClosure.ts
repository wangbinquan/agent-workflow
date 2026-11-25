import type { TaskExecutionPermits } from '@/modules/task-execution/public/participants'
import type { WorkspacePresenceQueries } from '@/modules/source-control/public/queries'
import type { TerminalWorkspacePrunePolicy } from '@/modules/task-execution/public/types'
import {
  createTaskNodeStatusEventsParticipantInTx,
  createHumanGateNodeRunStateParticipantInTx,
  createTaskDecisionParticipantInTx,
  createHumanGateNodeRunMintParticipantInTx,
  createHumanGateTaskTransitionParticipantInTx,
  createHumanGateNodeRunMintOperations,
  createTaskAuthorizationQueries,
  createTaskAuthorizationParticipantInTx,
  createNodeRunWorkspaceRollback,
  createHumanGatePersistenceParticipantInTx,
  createConsumedInputsParticipantInTx,
  createTaskClarifyDirectivePersistence,
  bindTaskSubjectQueries,
  createRunSelectionReader,
  createNodeRunQueries,
  createTaskGateQueries,
  createNodeOutputQueries,
  nodeRunStatusCondition,
  bindTaskGateOpenCondition,
  taskGateVisibleCondition,
} from '@/modules/task-execution/composition'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import {
  composeTaskCollaborationReads,
  composeTaskMembershipOperations,
  composeHumanGateOpenParticipantFactory,
} from '@/modules/collaboration/composition'
import {
  composeReviewUpstreamAgents,
  composeCollaborationTaskRolePolicy,
  createWorkflowExecutionQueries,
  workflowNameExpression,
} from '@/modules/resource-catalog/composition'
import { composeHumanGateTaskLockPort } from '@/modules/task-execution/composition'
// RFC-592: collaboration's review gate rollback takes the workspace snapshot rollback through its bindings.
import { rollbackToSnapshot } from '@/util/git'

/** RFC-395 II-b O2: the selected session's owner adapters travel through explicit dependencies. */
export function composeCrossContextClosure(
  db: PersistenceDb,
  executionPermits: TaskExecutionPermits,
  /** RFC-526: the session's workspace presence (the daemon: its deployment's; the maintenance worker: the local one). */
  workspacePresence: WorkspacePresenceQueries,
  /** RFC-534: the session's terminal workspace prune policy (the maintenance worker: the never-prune one). */
  terminalWorkspacePrune: TerminalWorkspacePrunePolicy,
) {
  const taskRolePolicy = composeCollaborationTaskRolePolicy()
  const taskExecutionParticipants = composeTaskExecutionParticipantBindings(
    executionPermits,
    workspacePresence,
    terminalWorkspacePrune,
  )
  return {
    taskRolePolicy,
    taskExecutionParticipants,
    humanGateOpen: composeHumanGateOpenParticipantFactory(),
    taskMembership: composeTaskMembershipOperations(db, taskRolePolicy, taskExecutionParticipants),
    collaborationReads: composeTaskCollaborationReads(db, taskExecutionParticipants),
    upstreamAgents: composeReviewUpstreamAgents(db),
    taskLock: composeHumanGateTaskLockPort,
  }
}

/** Factory references only: participants are constructed at the original call sites. */
export function composeTaskExecutionParticipantBindings(
  executionPermits: TaskExecutionPermits,
  workspacePresence: WorkspacePresenceQueries,
  terminalWorkspacePrune: TerminalWorkspacePrunePolicy,
) {
  return Object.freeze({
    executionPermits,
    workspacePresence,
    terminalWorkspacePrune,
    createTaskNodeStatusEventsParticipantInTx,
    createHumanGateNodeRunStateParticipantInTx,
    createTaskDecisionParticipantInTx,
    createHumanGateNodeRunMintParticipantInTx,
    createHumanGateTaskTransitionParticipantInTx,
    createHumanGateNodeRunMintOperations,
    createTaskAuthorizationQueries,
    createTaskAuthorizationParticipantInTx,
    createNodeRunWorkspaceRollback,
    rollbackWorkspaceToSnapshot: rollbackToSnapshot,
    createHumanGatePersistenceParticipantInTx,
    createConsumedInputsParticipantInTx,
    createTaskClarifyDirectivePersistence,
    // RFC-568: bound with Resource Catalog's workflow read factory (workflow names next to the task subjects).
    createTaskSubjectQueries: bindTaskSubjectQueries(createWorkflowExecutionQueries),
    createRunSelectionReader,
    createNodeRunQueries,
    createTaskGateQueries,
    createNodeOutputQueries,
    nodeRunStatusCondition,
    // RFC-567: the open condition's "task has a subject name" arm reads Resource Catalog's workflow name fragment.
    taskGateOpenCondition: bindTaskGateOpenCondition(workflowNameExpression),
    taskGateVisibleCondition,
  })
}
