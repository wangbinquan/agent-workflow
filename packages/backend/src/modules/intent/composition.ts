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

// RFC-503: Intent's platform inventory participant and workflow graph validation are application use cases; bootstrap takes their
// factories via composition.
export { createIntentPlatformInventoryParticipant } from './application/platformInventoryParticipant'
export { createIntentWorkflowGraphValidation } from './application/workflowGraphValidationProvider'

// RFC-518: the CrewStation / task-image adapters live in infrastructure/crewstation; bootstrap takes them here.
export { composeCrewStationIntentScratchStore } from './infrastructure/crewstation/crewstationScratch'
