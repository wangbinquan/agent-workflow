import type { PersistenceDb, PersistenceTx } from '@/platform/persistence/persistenceDb'
import type {
  HumanGateNodeRunMintOperations,
  HumanGateNodeRunMintParticipantInTx,
  HumanGateNodeRunStateParticipantInTx,
  HumanGateTaskTransitionParticipantInTx,
  TaskDecisionParticipantInTx,
  TaskNodeStatusEventsParticipantInTx,
} from '../public/participants'
import type {
  HumanGateNodeRunMintRequest,
  HumanGateNodeRunSetRequest,
  HumanGateNodeRunTransitionRequest,
  HumanGateTaskNodeStatusesRequest,
  HumanGateTaskTransitionRequest,
} from '../application/ports/humanGateTaskParticipants'
import type { AcceptHumanGateDecisionInput } from '../application/acceptHumanGateDecision'
import { appendTaskNodeStatusesCommittedEvent } from './taskLifecycleCommittedEvents'
import { setNodeRunStatusTx, transitionNodeRunStatusTx } from './nodeRunLifecycleTransition'
import { acceptHumanGateDecisionTx } from './taskDecisionParticipant'
import {
  createNodeRunMintParticipantInTx,
  type NodeRunMintParticipantInTx,
} from './nodeRunMintParticipant'
import { transitionHumanGateTask } from './humanGateTaskTransition'
import { DrizzleNodeRunLifecyclePersistence } from './nodeRunLifecyclePersistence'

// Private capability bindings, never a shared transaction or a cached participant instance.
const transactions = new WeakMap<object, PersistenceTx>()
const mintParticipants = new WeakMap<object, NodeRunMintParticipantInTx>()

export function createTaskNodeStatusEventsParticipantInTx(
  tx: PersistenceTx,
): TaskNodeStatusEventsParticipantInTx {
  const participant = Object.freeze({
    append: (input: HumanGateTaskNodeStatusesRequest) =>
      appendTaskNodeStatusesCommittedEvent(transactions.get(participant)!, input),
  }) as TaskNodeStatusEventsParticipantInTx
  transactions.set(participant, tx)
  return participant
}

export function createHumanGateNodeRunStateParticipantInTx(
  tx: PersistenceTx,
): HumanGateNodeRunStateParticipantInTx {
  const participant = Object.freeze({
    setNodeRunStatus: (input: HumanGateNodeRunSetRequest) =>
      setNodeRunStatusTx({ ...input, tx: transactions.get(participant)! }),
    transitionNodeRunStatus: (input: HumanGateNodeRunTransitionRequest) =>
      transitionNodeRunStatusTx({ ...input, tx: transactions.get(participant)! }),
  }) as HumanGateNodeRunStateParticipantInTx
  transactions.set(participant, tx)
  return participant
}

export function createTaskDecisionParticipantInTx(tx: PersistenceTx): TaskDecisionParticipantInTx {
  const participant = Object.freeze({
    acceptGateDecisionTx: (input: AcceptHumanGateDecisionInput) =>
      acceptHumanGateDecisionTx(transactions.get(participant)!, input),
  }) as TaskDecisionParticipantInTx
  transactions.set(participant, tx)
  return participant
}

export function createHumanGateNodeRunMintParticipantInTx(
  tx: PersistenceTx,
): HumanGateNodeRunMintParticipantInTx {
  const mint = createNodeRunMintParticipantInTx(tx)
  const participant = Object.freeze({
    mint: (input: HumanGateNodeRunMintRequest) => mintParticipants.get(participant)!.mint(input),
  }) as HumanGateNodeRunMintParticipantInTx
  mintParticipants.set(participant, mint)
  return participant
}

export function createHumanGateTaskTransitionParticipantInTx(
  tx: PersistenceTx,
): HumanGateTaskTransitionParticipantInTx {
  const participant = Object.freeze({
    transition: (input: HumanGateTaskTransitionRequest) =>
      transitionHumanGateTask(transactions.get(participant)!, input),
  }) as HumanGateTaskTransitionParticipantInTx
  transactions.set(participant, tx)
  return participant
}

export function createHumanGateNodeRunMintOperations(
  db: PersistenceDb,
): HumanGateNodeRunMintOperations {
  const persistence = new DrizzleNodeRunLifecyclePersistence(db)
  return Object.freeze({ mint: (input: HumanGateNodeRunMintRequest) => persistence.mint(input) })
}
