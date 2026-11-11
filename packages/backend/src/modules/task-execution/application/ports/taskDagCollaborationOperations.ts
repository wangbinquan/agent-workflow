// RFC-481 — the scheduler's required port for collaboration's DAG projection (open clarify evidence, deferred question
// dispatch, undispatched park targets). Declared here, moved from collaboration `application/ports/`; collaboration
// implements it.
export interface TaskDagOpenClarifyEvidence {
  readonly clarifyNodeIds: ReadonlySet<string>
  readonly askingRunIds: ReadonlySet<string>
}

/**
 * The scheduler projection collaboration provides. Task Execution consumes only
 * these closed values; question ledgers, clarify rounds and provider transactions
 * stay behind collaboration's selected adapter.
 */
export interface TaskDagCollaborationOperations {
  autoDispatchDeferredQuestions(taskId: string): Promise<void>
  loadOpenClarifyEvidence(taskId: string): Promise<TaskDagOpenClarifyEvidence>
  loadUndispatchedParkTargets(taskId: string): Promise<ReadonlySet<string>>
}
