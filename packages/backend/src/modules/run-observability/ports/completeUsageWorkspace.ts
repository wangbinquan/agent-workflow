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
  /** Actual parent references are streamed through EOF, never converted to a truncated array. */
  nativePath?(record: T): AsyncIterable<{
    readonly session: string
    readonly parentSession: string | null
    readonly depth: string
    readonly pathDigest: string
  }>
  bindNativeAncestry?(
    group: string,
    link: {
      readonly session: string
      readonly parentSession: string | null
      readonly depth: string
      readonly pathDigest: string
    },
  ): Promise<void>
  /** Derived from the fully retained input, so request-only groups need no overlap queries. */
  markSummary?(group: string): Promise<void>
  hasSummaries?(group: string): Promise<boolean>
  /** Output is derived allocation only; never a usage-ledger revision. */
  allocate(
    record: T,
    contribution: TokenUsage,
    quality: { ambiguous: boolean; unavailable: boolean },
  ): Promise<void>
}
