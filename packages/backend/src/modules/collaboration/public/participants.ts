// RFC-333/RFC-341 — collaboration's exact offered participant receipts and
// transaction participants. The provider adapter for task-execution's
// consumer-owned human-gate SPI remains module-internal.

import {
  appendHumanGateDecisionCommittedEventTx as appendHumanGateDecisionCommittedEventTxInternal,
  appendQuestionDispatchCommittedEventTx as appendQuestionDispatchCommittedEventTxInternal,
  appendReviewCommentsChangedCommittedEventTx as appendReviewCommentsChangedCommittedEventTxInternal,
  appendReviewSelectionChangedCommittedEventTx as appendReviewSelectionChangedCommittedEventTxInternal,
} from '../infrastructure/collaborationCommittedEventParticipant'

export type { HumanGateOpenParticipantResult } from '../application/ports/humanGateOpenParticipant'

// Keep infrastructure bindings behind exact public participant values. A
// direct re-export makes the public contract recursively expose DbTxSync and
// the platform event-store receipt types even though callers only invoke the
// collaboration-owned transaction participant.
export const appendHumanGateDecisionCommittedEventTx =
  appendHumanGateDecisionCommittedEventTxInternal
export const appendQuestionDispatchCommittedEventTx = appendQuestionDispatchCommittedEventTxInternal
export const appendReviewCommentsChangedCommittedEventTx =
  appendReviewCommentsChangedCommittedEventTxInternal
export const appendReviewSelectionChangedCommittedEventTx =
  appendReviewSelectionChangedCommittedEventTxInternal
