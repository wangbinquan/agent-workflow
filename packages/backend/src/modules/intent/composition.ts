// RFC-395 I-a: schema-only composition root.
export {
  schemaContribution,
  intentApplyJournal,
  intentDraftResolutions,
  intentDrafts,
  intentProvenance,
  intentSessions,
  intentTurnEvents,
  intentTurns,
  intentWorkingSetChanges,
} from './infrastructure/persistence/schema'

export { createIntentTurnEventRetentionPhase } from './infrastructure/retentionPhase'
