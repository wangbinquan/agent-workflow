import { testExecutionPermits } from './executionPermits'
import type { TaskExecutionParticipantBindings } from '@/modules/collaboration/infrastructure/taskExecutionParticipantBindings'
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

export const taskExecutionParticipants: TaskExecutionParticipantBindings = Object.freeze({
  executionPermits: testExecutionPermits,
  createTaskNodeStatusEventsParticipantInTx,
  createHumanGateNodeRunStateParticipantInTx,
  createTaskDecisionParticipantInTx,
  createHumanGateNodeRunMintParticipantInTx,
  createHumanGateTaskTransitionParticipantInTx,
  createHumanGateNodeRunMintOperations,
  createTaskAuthorizationQueries,
  createTaskAuthorizationParticipantInTx,
})
