/** Original read identity contains no execution context or owner dependency. */
export interface NativeUsageReadBinding {
  readonly taskId: string
  readonly nodeRunId: string
  readonly invocationId: string
}
