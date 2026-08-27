// RFC-333 — collaboration composition root. Legacy callers enter through one
// temporary service bridge until their constructors receive these dependencies.

export { composeTaskExecutionHumanGateAdapter } from './application/adapters/task-execution-human-gate-adapter'
export { createCollaborationCommandContext } from './composition/commandContext'

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
