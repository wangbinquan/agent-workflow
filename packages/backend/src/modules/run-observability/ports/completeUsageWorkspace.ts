import type { UsageContributionEvidence } from '../domain/usageSelection'
import type { TokenUsage } from '../domain/tokenUsage'
import type { CoverageIntervalStore } from '../domain/coverageIntervalIndex'

export interface CompleteUsageWorkspace<T extends UsageContributionEvidence> {
  readonly coverage: CoverageIntervalStore
  /** Replay the fully retained input to validate all ancestry before allocating any bucket. */
  records(): AsyncIterable<T>
  /** Original JS localeCompare ordering, externally merged; no SQL collation substitution. */
  orderedRecords(): AsyncIterable<T>
  /** Same group/session with a different full path must fail. */
  bindAncestry(group: string, session: string, ancestors: readonly string[]): Promise<void>
  /** Output is derived allocation only; never a usage-ledger revision. */
  allocate(
    record: T,
    contribution: TokenUsage,
    quality: { ambiguous: boolean; unavailable: boolean },
  ): Promise<void>
}
