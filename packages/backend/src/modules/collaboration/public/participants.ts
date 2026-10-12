// RFC-333/RFC-341 — collaboration's exact offered participant receipts and
// transaction participants. The provider adapter for task-execution's
// consumer-owned human-gate SPI remains module-internal.

import { createWorkgroupClarifyAskGate as createWorkgroupClarifyAskGateInternal } from '../infrastructure/workgroupClarifyAskGate'

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

// RFC-359：collaboration 的四个**同步** committed-event 参与者
// （`appendHumanGate{Opened,Decision}` / `appendReview{CommentsChanged,SelectionChanged}` /
// `appendQuestionDispatch…CommittedEventTx`，整个 `collaborationCommittedEventParticipant.ts`）
// 随 `dbTxSync` 在 src 侧归零而退役——它们的宿主早已改走统一事务原语，生产侧零消费者。
// 事件形状仍只有一份，在 `collaborationCommittedEvents.ts`。
// RFC-359 W1-T7e：工作组 asker 的反问许可（RFC-207 §3.7.2 唯一判定点），两个 provider 同一份。
export const createWorkgroupClarifyAskGate = createWorkgroupClarifyAskGateInternal
// RFC-359 W4-D19c-tail：`countWorkgroupClarifyAsks` 的唯一生产消费者是 legacy 工作组引擎的转发层，
// 随该岛一并退役；计数本身仍在 gate 内部使用，不再对外开口（删除优于留一个零消费者的公共符号）。
