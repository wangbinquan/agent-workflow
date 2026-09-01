export interface TaskLifecycleAutoRepairPolicy {
  readonly enabledRules: readonly string[]
  readonly maxPerWindow: number
  readonly windowMs: number
}

export interface TaskLifecycleAutoRepairResult {
  readonly repaired: Array<
    Readonly<{
      taskId: string
      alertId: string
      optionId: string
      outcome: string
    }>
  >
  readonly skipped: Array<
    Readonly<{
      taskId: string
      alertId: string
      reason: string
    }>
  >
}

/** Closed provider-owned detect/classify/repair command used by the daemon loop. */
export interface TaskLifecycleAutoRepairCommand {
  run(policy: TaskLifecycleAutoRepairPolicy): Promise<TaskLifecycleAutoRepairResult>
}
