/**
 * Provider-neutral retry-index allocator over an already-frozen row set.
 * Callers retain ownership of their provider transaction and query scope.
 */

import { nodeRunAttemptIndex } from '../domain/nodeRunAttempt'
export function nextRetryIndex(
  rows: ReadonlyArray<{
    readonly retryIndex: number
    readonly parentNodeRunId?: string | null
    readonly iteration?: number
  }>,
  opts: { readonly topLevelOnly?: boolean; readonly iteration?: number } = {},
): number {
  return nodeRunAttemptIndex({ kind: 'max-plus-one', rows, ...opts })
}
