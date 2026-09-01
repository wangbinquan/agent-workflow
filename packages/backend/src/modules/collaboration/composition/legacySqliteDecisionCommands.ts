// RFC-349 — bootstrap-only SQLite compatibility composition. Keeping these
// factories off the context-wide composition barrel prevents the legacy
// services they bridge from forming a value cycle back through that barrel.

export { createSqliteReviewDecisionCommand } from '../infrastructure/legacySqliteReviewDecisionComposition'
export { createSqliteQuestionDispatchCommand } from '../infrastructure/legacySqliteQuestionDispatchComposition'
export { createSqliteClarifyDecisionCommand } from '../infrastructure/legacySqliteClarifyDecisionComposition'
