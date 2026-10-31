import {
  createTaskNodeStatusEventsParticipantInTx,
  createHumanGateNodeRunStateParticipantInTx,
  createTaskDecisionParticipantInTx,
  createHumanGateNodeRunMintParticipantInTx,
  createHumanGateTaskTransitionParticipantInTx,
  createHumanGateNodeRunMintOperations,
  createTaskAuthorizationQueries,
  createTaskAuthorizationParticipantInTx,
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
export function composeCrossContextClosure(db: PersistenceDb) {
  const taskRolePolicy = composeCollaborationTaskRolePolicy()
  return {
    taskRolePolicy,
    taskExecutionParticipants: composeTaskExecutionParticipantBindings(),
    humanGateOpen: composeHumanGateOpenParticipantFactory(),
    taskMembership: composeTaskMembershipOperations(db, taskRolePolicy),
    collaborationReads: composeTaskCollaborationReads(db),
    upstreamAgents: composeReviewUpstreamAgents(db),
    taskLock: composeHumanGateTaskLockPort,
  }
}

/** Factory references only: participants are constructed at the original call sites. */
export function composeTaskExecutionParticipantBindings() {
  return Object.freeze({
    createTaskNodeStatusEventsParticipantInTx,
    createHumanGateNodeRunStateParticipantInTx,
    createTaskDecisionParticipantInTx,
    createHumanGateNodeRunMintParticipantInTx,
    createHumanGateTaskTransitionParticipantInTx,
    createHumanGateNodeRunMintOperations,
    createTaskAuthorizationQueries,
    createTaskAuthorizationParticipantInTx,
  })
}
