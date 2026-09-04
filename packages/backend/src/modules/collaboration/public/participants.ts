// RFC-333/RFC-341 — collaboration's exact offered participant receipts and
// transaction participants. The provider adapter for task-execution's
// consumer-owned human-gate SPI remains module-internal.

import {
  appendHumanGateDecisionCommittedEventTx as appendHumanGateDecisionCommittedEventTxInternal,
  appendQuestionDispatchCommittedEventTx as appendQuestionDispatchCommittedEventTxInternal,
  appendReviewCommentsChangedCommittedEventTx as appendReviewCommentsChangedCommittedEventTxInternal,
  appendReviewSelectionChangedCommittedEventTx as appendReviewSelectionChangedCommittedEventTxInternal,
} from '../infrastructure/collaborationCommittedEventParticipant'
import {
  countWorkgroupClarifyAsks as countWorkgroupClarifyAsksInternal,
  createWorkgroupClarifyAskGate as createWorkgroupClarifyAskGateInternal,
} from '../infrastructure/workgroupClarifyAskGate'

export type { HumanGateOpenParticipantResult } from '../application/ports/humanGateOpenParticipant'
export type {
  TaskDagCollaborationOperations,
  TaskDagOpenClarifyEvidence,
} from '../application/ports/taskDagCollaborationOperations'
export type {
  CollaborationAgentClarifyOpenInput,
  CollaborationAgentClarifyOpenReceipt,
  CollaborationAutonomousDismissalInput,
  CollaborationAutonomousDismissalResult,
  CollaborationBorrowResolutionInput,
  CollaborationClarifyDirectiveInput,
  CollaborationClarifyQueueContext,
  CollaborationClarifyQueueInput,
  CollaborationClarifySuppressionInput,
  CollaborationCrossClarifyInspectInput,
  CollaborationCrossClarifyInspectResult,
  CollaborationReviewDispatchInput,
  CollaborationReviewDispatchResult,
  CollaborationReviewPromptInput,
  CollaborationRuntimeMechanics,
  CollaborationTaskRuntimeOperations,
} from '../application/ports/collaborationRuntimeMechanics'
export type { ClarifyRepairParticipant } from '../application/ports/clarifyRepairParticipant'
export type {
  ReviewRepairInspection,
  ReviewRepairParticipant,
} from '../application/ports/reviewRepairParticipant'
export type {
  AddReviewCommentInput,
  AddedReviewComment,
  CollaborationClarifyDraftEventPublisher,
  CollaborationRouteActor,
  CollaborationRouteOperations,
  CollaborationTaskQuestionView,
  ListClarifySummariesInput,
  ListReviewSummariesInput,
  ReassignTaskQuestionAction,
  ReviewCommentWriteAuthority,
  SaveClarifyDraftInput,
  SaveClarifyDraftResult,
  SealClarifyQuestionsInput,
  SealClarifyQuestionsResult,
} from '../application/ports/collaborationRouteOperations'

// Keep infrastructure bindings behind exact public participant values. A
// direct re-export makes the public contract recursively expose DbTxSync and
// the platform event-store receipt types even though callers only invoke the
// collaboration-owned transaction participant.
export const appendHumanGateDecisionCommittedEventTx =
  appendHumanGateDecisionCommittedEventTxInternal
export const appendQuestionDispatchCommittedEventTx = appendQuestionDispatchCommittedEventTxInternal
export const appendReviewCommentsChangedCommittedEventTx =
  appendReviewCommentsChangedCommittedEventTxInternal
// RFC-359 W1-T7e：工作组 asker 的反问许可（RFC-207 §3.7.2 唯一判定点），两个 provider 同一份。
export const createWorkgroupClarifyAskGate = createWorkgroupClarifyAskGateInternal
export const countWorkgroupClarifyAsks = countWorkgroupClarifyAsksInternal
export const appendReviewSelectionChangedCommittedEventTx =
  appendReviewSelectionChangedCommittedEventTxInternal
