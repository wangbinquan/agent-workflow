// Frozen from 67ab6b9aed08d97dcd6d3d9dfb57b8885a11f8e6:packages/backend/src/modules/task-execution/application/nextRetryIndex.ts; copied verbatim.
/**
 * Provider-neutral retry-index allocator over an already-frozen row set.
 * Callers retain ownership of their provider transaction and query scope.
 */
export function nextRetryIndex(
  rows: ReadonlyArray<{
    readonly retryIndex: number
    readonly parentNodeRunId?: string | null
    readonly iteration?: number
  }>,
  opts: { readonly topLevelOnly?: boolean; readonly iteration?: number } = {},
): number {
  let max = -1
  for (const row of rows) {
    if (opts.topLevelOnly === true && (row.parentNodeRunId ?? null) !== null) continue
    if (opts.iteration !== undefined && row.iteration !== opts.iteration) continue
    if (row.retryIndex > max) max = row.retryIndex
  }
  return max + 1
}
