// RFC-333/RFC-341 — collaboration's exact offered participant receipts and
// transaction participants. The provider adapter for task-execution's
// consumer-owned human-gate SPI remains module-internal.

export type { HumanGateOpenParticipantResult } from '../application/ports/humanGateOpenParticipant'

export {
  appendHumanGateDecisionCommittedEventTx,
  appendQuestionDispatchCommittedEventTx,
  appendReviewCommentsChangedCommittedEventTx,
  appendReviewSelectionChangedCommittedEventTx,
} from '../infrastructure/collaborationCommittedEventParticipant'
