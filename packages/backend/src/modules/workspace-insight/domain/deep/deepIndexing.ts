// RFC-083 PR-E — the deep (SCIP) mode's outcome vocabulary: why a deep pass degraded, what one indexer run
// produced, and the error the structural-diff service turns into a baseline answer. RFC-453: gathered here from
// the runner and the orchestrator so the application layer names them without importing infrastructure.

import type { DeepIndexerOverrides } from './indexers'

export type DeepDegradedReason = 'indexer-missing' | 'build-failed' | 'timeout' | 'scip-parse-error'

export interface IndexerRunResult {
  ok: boolean
  scipBytes?: Uint8Array
  reason?: DeepDegradedReason
}

export class DeepUnavailableError extends Error {
  constructor(
    public readonly reason: DeepDegradedReason,
    message: string,
  ) {
    super(message)
    this.name = 'DeepUnavailableError'
  }
}

/** RFC-370 §10 V16 — the content of this task does not live on this host, so
 *  no SCIP indexer can run against it; the baseline answers instead. */
export const DEEP_INDEXING_UNAVAILABLE = 'indexing-unavailable'

export interface ResolvedDeepConfig {
  overrides?: DeepIndexerOverrides
  timeoutMs: number
}
