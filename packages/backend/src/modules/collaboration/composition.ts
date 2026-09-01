// RFC-333 — collaboration composition root. Legacy callers enter through one
// temporary service bridge until their constructors receive these dependencies.

export { composeTaskExecutionHumanGateAdapter } from './composition/taskExecutionHumanGateAdapter'
export { createSqliteCollaborationTaskAccessPort } from './infrastructure/sqliteCollaborationTaskAccess'
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
export { createPostgresqlTaskDagCollaborationOperations } from './infrastructure/postgresqlTaskDagCollaborationOperations'
export {
  createCollaborationWsProjector,
  createSqliteCollaborationCommittedEventProjection,
} from './infrastructure/collaborationCommittedEventWsProjector'
export { createPostgresqlCollaborationCommittedEventProjection } from './infrastructure/postgresqlCollaborationCommittedEventProjection'
export { createSqliteHumanGateContinuationRecoveryQueries } from './infrastructure/sqliteHumanGateContinuationRecovery'
export { createPostgresqlHumanGateContinuationRecoveryQueries } from './infrastructure/postgresqlHumanGateContinuationRecovery'
export { createSqliteHumanGateTerminalSweepCommand } from './infrastructure/sqliteHumanGateTerminalSweep'
export { createPostgresqlHumanGateTerminalSweepCommand } from './infrastructure/postgresqlHumanGateTerminalSweep'
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
