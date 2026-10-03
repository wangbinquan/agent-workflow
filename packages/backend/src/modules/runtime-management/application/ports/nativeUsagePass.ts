import type { ObservationTokenUsage } from '@agent-workflow/shared'

/** Supplied by the accepted runtime owner. A reader never guesses a store or turn identity. */
export interface NativeUsagePassIdentity {
  readonly passId: string
  readonly invocationId: string
  readonly nativeSource: string
  readonly sourceGeneration: string
  readonly rootSessionId: string
  readonly lineage: string
  readonly epoch: string
  readonly phase: 'baseline' | 'final'
}

/** Parent references are paged separately, so an arbitrarily deep tree needs no ancestor array. */
export interface NativeUsagePassSession {
  readonly id: string
  readonly parentSessionId: string | null
}
export interface NativeUsagePassStep extends NativeUsagePassSession {
  readonly stepId: string
  readonly occurredAt: number | null
  readonly usage: ObservationTokenUsage
  readonly model: { readonly provider: string; readonly id: string } | null
}
export interface NativeUsagePassCounts {
  readonly sessions: string
  readonly parts: string
  readonly steps: string
}
export interface NativeUsagePassPage {
  readonly identity: NativeUsagePassIdentity
  readonly ordinal: string
  readonly cursor: string
  readonly nextCursor: string | null
  readonly previousDigest: string
  readonly payloadDigest: string
  readonly cumulativeDigest: string
  readonly scanPositionBefore: string
  readonly scanPositionAfter: string
  readonly scannedRawRows: string
  readonly counts: NativeUsagePassCounts
  readonly sessions: readonly NativeUsagePassSession[]
  readonly steps: readonly NativeUsagePassStep[]
  readonly issues: readonly string[]
  /** Present only after the original part, child-session and queue queries all reach EOF. */
  readonly eof: { readonly fingerprint: string; readonly counts: NativeUsagePassCounts } | null
}
export interface NativeUsagePassReader {
  readonly identity: NativeUsagePassIdentity
  readonly initialCursor: string
  /** One frozen page may be retried. No next page is read until its original owner ACK. */
  next(cursor: string): NativeUsagePassPage
  acknowledge(ordinal: string, payloadDigest: string): void
  /** An interrupted snapshot cannot be reopened under the same pass by this reader. */
  close(): void
}
