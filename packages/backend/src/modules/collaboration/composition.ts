// RFC-333 — collaboration composition root. Legacy callers enter through one
// temporary service bridge until their constructors receive these dependencies.

// RFC-359 W4-B3：实现只有一份；provider 具名导出只做绑定（bootstrap 收敛后一并删）。
export {
  createCollaborationTaskAccessPort,
  createCollaborationTaskAccessPort as createSqliteCollaborationTaskAccessPort,
  createCollaborationTaskAccessPort as createPostgresqlCollaborationTaskAccessPort,
} from './infrastructure/collaborationTaskAccess'
export { planMembersReplacement } from './infrastructure/legacySqliteTaskCollab'
// RFC-359 W7：RFC-057 修复的两个协作侧端口也各只剩一份实现；provider 具名导出只做绑定。
export {
  createClarifyRepairParticipant,
  createClarifyRepairParticipant as createSqliteClarifyRepairParticipant,
  createClarifyRepairParticipant as createPostgresqlClarifyRepairParticipant,
} from './infrastructure/clarifyRepairParticipant'
export {
  createReviewRepairParticipant,
  createReviewRepairParticipant as createSqliteReviewRepairParticipant,
  createReviewRepairParticipant as createPostgresqlReviewRepairParticipant,
} from './infrastructure/reviewRepairParticipant'
// RFC-359 W7：运行期机制合一后只剩一个工厂（`infrastructure/collaborationRuntimeMechanics.ts`）。
export { createCollaborationRuntimeMechanics } from './infrastructure/collaborationRuntimeMechanics'
export {
  createCollaborationWsProjector,
  createSqliteCollaborationCommittedEventProjection,
} from './infrastructure/collaborationCommittedEventWsProjector'
export { createPostgresqlCollaborationCommittedEventProjection } from './infrastructure/postgresqlCollaborationCommittedEventProjection'
export {
  createHumanGateContinuationRecoveryQueries,
  createHumanGateContinuationRecoveryQueries as createSqliteHumanGateContinuationRecoveryQueries,
  createHumanGateContinuationRecoveryQueries as createPostgresqlHumanGateContinuationRecoveryQueries,
} from './infrastructure/humanGateContinuationRecovery'
export {
  createHumanGateTerminalSweepCommand,
  createHumanGateTerminalSweepCommand as createSqliteHumanGateTerminalSweepCommand,
  createHumanGateTerminalSweepCommand as createPostgresqlHumanGateTerminalSweepCommand,
} from './infrastructure/humanGateTerminalSweep'
export { createCollaborationClarifyDraftEventPublisher } from './infrastructure/collaborationClarifyDraftEventPublisher'
// RFC-359 W7：路由持久化面合一后只剩一个工厂（`infrastructure/collaborationRouteOperations.ts`）。
export {
  createCollaborationRouteOperations,
  type CreateCollaborationRouteOperationsInput,
} from './infrastructure/collaborationRouteOperations'
export {
  createCollaborationCommandContext,
  createPostgresqlCollaborationCommandContext,
} from './composition/commandContext'
export {
  composeWorkgroupTaskRoomClarifyParticipantFactory,
  type WorkgroupTaskRoomClarifyParticipantFactory,
} from './composition/workgroupTaskRoomClarify'

// RFC-333 temporary legacy bridge inventory. These symbols stay internal to
// the collaboration context: services/humanGateComposition.ts is the sole
// compatibility importer and removes this block when W2-D injects the legacy
// service dependencies directly.
export { prepareWorkspaceRollbackPlan } from './application/prepareWorkspaceRollbackPlan'
export {
  canonicalHumanGateRequestHash,
  canonicalHumanGateValueJson,
  deriveHumanGateCompatibilityKey,
} from './domain/canonicalGateRequest'
export { decodeCollaborationCommittedEvent } from './domain/collaborationCommittedEvent'
export {
  decodeClarifyDecisionManifest,
  decodeClarifyDecisionReceipt,
  encodeClarifyDecisionManifest,
  encodeClarifyDecisionReceipt,
} from './domain/clarifyDecision'
export { gateDecisionReceipt } from './domain/gateReceipt'
export {
  decodeQuestionDispatchManifest,
  decodeQuestionDispatchReceipt,
  encodeQuestionDispatchManifest,
  encodeQuestionDispatchReceipt,
} from './domain/questionDispatchDecision'
export {
  decodeReviewDecisionManifest,
  decodeReviewDecisionReceipt,
  encodeReviewDecisionManifest,
  encodeReviewDecisionReceipt,
} from './domain/reviewDecision'
export { GitWorkspaceRollbackSnapshotInspector } from './infrastructure/gitWorkspaceRollbackSnapshotInspector'
