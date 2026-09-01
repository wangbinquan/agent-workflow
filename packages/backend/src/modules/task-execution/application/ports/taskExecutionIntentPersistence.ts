import type {
  CanonicalContinuationRequest,
  TaskExecutionIntentKind,
  TaskExecutionIntentSource,
  TaskExecutionIntentState,
} from '../../domain/executionIntent'

export interface SubmittedTaskExecutionIntent {
  readonly intentId: string
  readonly state: TaskExecutionIntentState
  readonly idempotent: boolean
  readonly requestHash: string
}

export interface SubmitTaskExecutionIntentInput {
  readonly request: CanonicalContinuationRequest
  readonly intentId?: string
  readonly replayAuthorizationId?: string | null
  readonly authorizationScopeJson?: string | null
  readonly admissionMode?: 'exclusive' | 'successor-after-claimed'
  readonly now?: number
}

/** Business command shape. The adapter derives the canonical lineage scope,
 * validates/rebinds retained replay decisions and writes the intent atomically. */
export interface SubmitTaskContinuationInput {
  readonly taskId: string
  readonly intentId: string
  readonly kind: TaskExecutionIntentKind
  readonly source: TaskExecutionIntentSource
  readonly actorUserId: string | null
  readonly payload: Readonly<Record<string, unknown>>
  readonly now: number
  readonly advanceOperationGeneration: boolean
  readonly admissionMode?: 'exclusive' | 'successor-after-claimed'
}

/** Named, atomic continuation admission. */
export interface TaskExecutionIntentPersistence {
  hasPendingGateSuccessor(taskId: string): Promise<boolean>
  submitContinuation(input: SubmitTaskContinuationInput): Promise<SubmittedTaskExecutionIntent>
  /** Canonical admission is kept for provider-private participants that have
   * already derived and fenced the task lineage in the same atomic use case. */
  submit(input: SubmitTaskExecutionIntentInput): Promise<SubmittedTaskExecutionIntent>
}
