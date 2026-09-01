// RFC-349 — named provider-neutral intent terminalization.

export interface TerminalizeTaskExecutionIntentsInput {
  readonly taskId: string
  readonly state: 'canceled' | 'failed'
  readonly failureCode: string
  readonly now: number
  readonly claimedOwnerEpoch?: number
}

export interface TaskExecutionIntentTerminalPersistence {
  terminalize(input: TerminalizeTaskExecutionIntentsInput): Promise<void>
}

export async function terminalizeTaskExecutionIntents(
  persistence: TaskExecutionIntentTerminalPersistence,
  input: TerminalizeTaskExecutionIntentsInput,
): Promise<void> {
  await persistence.terminalize(input)
}
