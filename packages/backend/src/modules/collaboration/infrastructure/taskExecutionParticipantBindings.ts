import type { TaskExecutionPermits } from '@/modules/task-execution/public/participants'
import type { PersistenceDb, PersistenceTx } from '@/platform/persistence/persistenceDb'
import type { NodeRunWorkspaceRollbackPort } from '../application/ports/nodeRunWorkspaceRollback'
import type {
  AsyncTaskAuthorizationParticipantInTx,
  TaskAuthorizationQueries,
  TaskNodeStatusEventsParticipantInTx,
  HumanGateNodeRunStateParticipantInTx,
  TaskDecisionParticipantInTx,
  HumanGateNodeRunMintParticipantInTx,
  HumanGateTaskTransitionParticipantInTx,
  HumanGateNodeRunMintOperations,
} from '@/modules/task-execution/public/participants'

/** Assembly input: bootstrap passes owner factory references, never prebuilt participants. */
export interface TaskExecutionParticipantBindings {
  readonly executionPermits: TaskExecutionPermits
  readonly createTaskNodeStatusEventsParticipantInTx: (
    tx: PersistenceTx,
  ) => TaskNodeStatusEventsParticipantInTx
  readonly createHumanGateNodeRunStateParticipantInTx: (
    tx: PersistenceTx,
  ) => HumanGateNodeRunStateParticipantInTx
  readonly createTaskDecisionParticipantInTx: (tx: PersistenceTx) => TaskDecisionParticipantInTx
  readonly createHumanGateNodeRunMintParticipantInTx: (
    tx: PersistenceTx,
  ) => HumanGateNodeRunMintParticipantInTx
  readonly createHumanGateTaskTransitionParticipantInTx: (
    tx: PersistenceTx,
  ) => HumanGateTaskTransitionParticipantInTx
  readonly createHumanGateNodeRunMintOperations: (
    db: PersistenceDb,
  ) => HumanGateNodeRunMintOperations
  readonly createTaskAuthorizationQueries: (db: PersistenceDb) => TaskAuthorizationQueries
  readonly createTaskAuthorizationParticipantInTx: (
    tx: PersistenceTx,
  ) => AsyncTaskAuthorizationParticipantInTx
  /** RFC-477: node-run workspace rollback (review rerun planning, clarify self-rollback). */
  readonly createNodeRunWorkspaceRollback: (db: PersistenceDb) => NodeRunWorkspaceRollbackPort
}
