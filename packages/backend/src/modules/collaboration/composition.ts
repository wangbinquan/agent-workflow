// RFC-333 — collaboration composition root. Legacy callers enter through one
// temporary service bridge until their constructors receive these dependencies.

export { composeTaskExecutionHumanGateAdapter } from './composition/taskExecutionHumanGateAdapter'
// RFC-359 W4-B3：实现只有一份；provider 具名导出只做绑定（bootstrap 收敛后一并删）。
export {
  createCollaborationTaskAccessPort,
  createCollaborationTaskAccessPort as createSqliteCollaborationTaskAccessPort,
  createCollaborationTaskAccessPort as createPostgresqlCollaborationTaskAccessPort,
} from './infrastructure/collaborationTaskAccess'
export { planMembersReplacement } from './infrastructure/legacySqliteTaskCollab'
export { createSqliteClarifyRepairParticipant } from './infrastructure/sqliteClarifyRepairParticipant'
export { createPostgresqlClarifyRepairParticipant } from './infrastructure/postgresqlClarifyRepairParticipant'
export { createSqliteReviewRepairParticipant } from './infrastructure/sqliteReviewRepairParticipant'
export { createPostgresqlReviewRepairParticipant } from './infrastructure/postgresqlReviewRepairParticipant'
export {
  createPostgresqlCollaborationRuntimeMechanics,
  type PostgresqlCollaborationNodeRunLifecycleParticipantFactory,
  type PostgresqlCollaborationRuntimeMechanicsDependencies,
} from './infrastructure/postgresqlCollaborationRuntimeMechanics'
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
export {
  createPostgresqlCollaborationRouteOperations,
  type CreatePostgresqlCollaborationRouteOperationsInput,
  type PostgresqlCollaborationRouteNodeLifecycleParticipantFactory,
} from './infrastructure/postgresqlCollaborationRouteOperations'
export {
  createCollaborationCommandContext,
  createPostgresqlCollaborationCommandContext,
} from './composition/commandContext'
export {
  composePostgresqlWorkgroupTaskRoomClarifyParticipantFactory,
  composeSqliteWorkgroupTaskRoomClarifyParticipantFactory,
  type PostgresqlWorkgroupTaskRoomClarifyParticipantFactory,
  type SqliteWorkgroupTaskRoomClarifyParticipantFactory,
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
export { SqliteHumanGateOperationStore } from './infrastructure/sqliteHumanGateOperationStore'
