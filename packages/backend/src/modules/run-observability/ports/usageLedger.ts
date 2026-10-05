import type {
  ObservationIngest,
  ObservationUsageCaptureCommit,
  ObservationNativeRevisionResolution,
} from '@agent-workflow/shared'
import type { UsageLedgerRecord } from '../domain/usageLedger'
import type {
  ObservationNativeScopeSource,
  ObservationNativeHistorySource,
} from '../public/participants'
import type { NativeHistoryProgress } from '../domain/nativeUsageHistory'

export interface UsageRevisionReceipt {
  readonly fingerprint: string
  readonly outcome: 'applied' | 'diagnostic' | 'stale'
}
export type NativeRevisionResolution = ObservationNativeRevisionResolution
export interface UsageCaptureReceipt extends ObservationUsageCaptureCommit {
  readonly sourceCursor: string
  readonly sourceId: string
  readonly resolutions: readonly NativeRevisionResolution[]
  readonly priorRevisionGap: boolean
  readonly history?: NativeHistoryProgress
}
/** Exact ownership over the entire original native index, reduced to one bounded batch. */
export interface NativeUsageOwnership {
  readonly owners: string
  /** Present only when exactly one original owner remains after excluding this invocation. */
  readonly candidate: UsageLedgerRecord | null
}
export interface UsageLedgerScope {
  /** Bind original Task evidence reads to this transaction, never a root pool connection. */
  bindNativeScopes?(source: ObservationNativeScopeSource): ObservationNativeScopeSource
  bindNativeHistory?(source: ObservationNativeHistorySource): ObservationNativeHistorySource
  cursor(): Promise<string | null>
  event(eventId: string): Promise<string | undefined>
  revision(invocationId: string, recordId: string, revision: number): Promise<string | undefined>
  /** Ordered retained evidence for rebuilding a meter after a late older revision. */
  revisions(
    invocationId: string,
    recordId: string,
    afterRevision: number,
    limit: number,
  ): Promise<readonly ObservationIngest['events'][number]['measurement'][]>
  current(invocationId: string, recordId: string): Promise<UsageLedgerRecord | undefined>
  append(
    event: ObservationIngest['events'][number],
    receipt: UsageRevisionReceipt,
    record: UsageLedgerRecord | undefined,
    nativeSource?: string,
  ): Promise<void>
  advance(cursor: string): Promise<void>
  capture(invocationId: string): Promise<UsageCaptureReceipt | undefined>
  commitCapture(
    value: ObservationUsageCaptureCommit,
    cursor: string,
    resolutions: readonly NativeRevisionResolution[],
    history?: NativeHistoryProgress,
  ): Promise<void>
  lockNativeRoot(nativeSource: string, root: string): Promise<void>
  nativeOwners(
    nativeSource: string,
    root: string,
    recordIds: readonly string[],
    excludeInvocationId: string,
  ): Promise<ReadonlyMap<string, NativeUsageOwnership>>
  nativeScope(sourceId: string): Promise<UsageLedgerScope>
}
export interface UsageLedgerStore {
  cursor(sourceId: string): Promise<string | null>
  change<T>(sourceId: string, work: (scope: UsageLedgerScope) => Promise<T>): Promise<T>
  records(
    taskId: string,
    page: { readonly limit: number; readonly after?: string },
  ): Promise<{ readonly items: readonly UsageLedgerRecord[]; readonly nextCursor?: string }>
  captures(invocationIds: readonly string[]): Promise<readonly UsageCaptureReceipt[]>
  pendingCaptureRepairs(limit: number, after?: string): Promise<readonly UsageCaptureReceipt[]>
}
