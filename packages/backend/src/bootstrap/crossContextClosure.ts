import type { TaskExecutionPermits } from '@/modules/task-execution/public/participants'
import type { WorkspacePresenceQueries } from '@/modules/source-control/public/queries'
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
  createTaskSubjectQueries,
  createRunSelectionReader,
  createNodeRunQueries,
  createTaskGateQueries,
  createNodeOutputQueries,
  nodeRunStatusCondition,
  taskGateOpenCondition,
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
} from '@/modules/resource-catalog/composition'
import { composeHumanGateTaskLockPort } from '@/modules/task-execution/composition'

/** RFC-395 II-b O2: the selected session's owner adapters travel through explicit dependencies. */
export function composeCrossContextClosure(
  db: PersistenceDb,
  executionPermits: TaskExecutionPermits,
  /** RFC-526: the session's workspace presence (the daemon: its deployment's; the maintenance worker: the local one). */
  workspacePresence: WorkspacePresenceQueries,
) {
  const taskRolePolicy = composeCollaborationTaskRolePolicy()
  const taskExecutionParticipants = composeTaskExecutionParticipantBindings(
    executionPermits,
    workspacePresence,
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
) {
  return Object.freeze({
    executionPermits,
    workspacePresence,
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
    createTaskSubjectQueries,
    createRunSelectionReader,
    createNodeRunQueries,
    createTaskGateQueries,
    createNodeOutputQueries,
    nodeRunStatusCondition,
    taskGateOpenCondition,
    taskGateVisibleCondition,
  })
}
