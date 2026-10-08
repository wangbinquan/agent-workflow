/** Original read identity contains no execution context or owner dependency. */
export interface NativeUsageReadBinding {
  readonly taskId: string
  readonly nodeRunId: string
  readonly invocationId: string
  /** Independent original System evidence; absence retains the original Task relation. */
  readonly sourceKind?: 'task' | 'system'
}
