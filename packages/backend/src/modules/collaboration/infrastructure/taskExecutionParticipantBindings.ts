import type { TaskExecutionPermits } from '@/modules/task-execution/public/participants'
import type { PersistenceDb, PersistenceTx } from '@/platform/persistence/persistenceDb'
import type { NodeRunWorkspaceRollbackPort } from '../application/ports/nodeRunWorkspaceRollback'
import type {
  AsyncTaskAuthorizationParticipantInTx,
  ConsumedInputsParticipantInTx,
  HumanGatePersistenceParticipantInTx,
  TaskAuthorizationQueries,
  TaskClarifyDirectivePersistence,
  TaskNodeStatusEventsParticipantInTx,
  HumanGateNodeRunStateParticipantInTx,
  TaskDecisionParticipantInTx,
  HumanGateNodeRunMintParticipantInTx,
  HumanGateTaskTransitionParticipantInTx,
  HumanGateNodeRunMintOperations,
} from '@/modules/task-execution/public/participants'
import type {
  TaskRunSelectionReads,
  TaskSubjectQueries,
} from '@/modules/task-execution/public/types'

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
  // RFC-482: the remaining task-execution participants and small reads collaboration uses. Each call site still passes
  // the handle it holds (a transaction stays a transaction), so these are factory references, not prebuilt instances.
  readonly createHumanGatePersistenceParticipantInTx: (
    tx: PersistenceTx,
  ) => HumanGatePersistenceParticipantInTx
  readonly createConsumedInputsParticipantInTx: () => ConsumedInputsParticipantInTx<PersistenceTx>
  readonly createTaskClarifyDirectivePersistence: (
    db: PersistenceDb,
  ) => TaskClarifyDirectivePersistence
  readonly createTaskSubjectQueries: (db: PersistenceDb) => TaskSubjectQueries
  readonly createRunSelectionReader: (db: PersistenceDb) => TaskRunSelectionReads
}
