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

// RFC-399 B1: bootstrap's maintenance job table takes these handlers via composition.
export { createIntentMaintenanceJobHandlers } from './application/maintenanceJobs'
