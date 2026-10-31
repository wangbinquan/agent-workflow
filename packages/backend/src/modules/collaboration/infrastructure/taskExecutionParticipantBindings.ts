import type { PersistenceDb, PersistenceTx } from '@/platform/persistence/persistenceDb'
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
}
