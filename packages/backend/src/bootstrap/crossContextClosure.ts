import type { TaskExecutionPermits } from '@/modules/task-execution/public/participants'
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
) {
  const taskRolePolicy = composeCollaborationTaskRolePolicy()
  const taskExecutionParticipants = composeTaskExecutionParticipantBindings(executionPermits)
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
export function composeTaskExecutionParticipantBindings(executionPermits: TaskExecutionPermits) {
  return Object.freeze({
    executionPermits,
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
  })
}
