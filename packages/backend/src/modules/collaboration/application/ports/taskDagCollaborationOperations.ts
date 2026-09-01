export interface TaskDagOpenClarifyEvidence {
  readonly clarifyNodeIds: ReadonlySet<string>
  readonly askingRunIds: ReadonlySet<string>
}

/**
 * Collaboration-owned scheduler projection. Task Execution consumes only these
 * closed values; question ledgers, clarify rounds and provider transactions stay
 * behind the selected adapter.
 */
export interface TaskDagCollaborationOperations {
  autoDispatchDeferredQuestions(taskId: string): Promise<void>
  loadOpenClarifyEvidence(taskId: string): Promise<TaskDagOpenClarifyEvidence>
  loadUndispatchedParkTargets(taskId: string): Promise<ReadonlySet<string>>
}

/** Required command supplied by the provider-native question-dispatch runtime. */
export interface DeferredTaskQuestionDispatcher {
  autoDispatchDeferredQuestions(taskId: string): Promise<void>
}
