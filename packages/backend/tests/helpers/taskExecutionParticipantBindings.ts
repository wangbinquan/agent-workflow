import { createFileWorkspacePresenceQueries } from '@/modules/source-control/composition/workspacePresence'
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
  neverPruneTerminalWorkspaces,
} from '@/modules/task-execution/composition'
import {
  createWorkflowExecutionQueries,
  workflowNameExpression,
} from '@/modules/resource-catalog/infrastructure/executionResourceQueries'
// RFC-592: the review gate's workspace rollback (the bootstrap binds the same function).
import { rollbackToSnapshot } from '@/modules/source-control/infrastructure/local/gitRepository'

export const taskExecutionParticipants: TaskExecutionParticipantBindings = Object.freeze({
  executionPermits: testExecutionPermits,
  // RFC-526: the human-gate parks take the session's workspace presence (the local one in these tests).
  workspacePresence: createFileWorkspacePresenceQueries(),
  // RFC-534: and its terminal workspace prune policy (a park never reaches done / canceled).
  terminalWorkspacePrune: neverPruneTerminalWorkspaces,
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
  // RFC-568: bound with Resource Catalog's workflow read factory, as bootstrap's cross-context closure does.
  createTaskSubjectQueries: bindTaskSubjectQueries(createWorkflowExecutionQueries),
  createRunSelectionReader,
  createNodeRunQueries,
  createTaskGateQueries,
  createNodeOutputQueries,
  nodeRunStatusCondition,
  // RFC-567: bound with Resource Catalog's workflow name fragment, as bootstrap's cross-context closure does.
  taskGateOpenCondition: bindTaskGateOpenCondition(workflowNameExpression),
  taskGateVisibleCondition,
})
