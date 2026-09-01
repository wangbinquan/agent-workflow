// RFC-349 — provider-neutral continuation admission command.

import type {
  SubmittedTaskExecutionIntent,
  SubmitTaskContinuationInput,
  TaskExecutionIntentPersistence,
} from './ports/taskExecutionIntentPersistence'

export type { SubmittedTaskExecutionIntent, SubmitTaskContinuationInput }

export async function submitTaskContinuation(
  persistence: TaskExecutionIntentPersistence,
  input: SubmitTaskContinuationInput,
): Promise<SubmittedTaskExecutionIntent> {
  return await persistence.submitContinuation(input)
}
