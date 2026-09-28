import type {
  ObservationIngest,
  ObservationCaptureCommit,
  ObservationNativeRevisionResolution,
} from '@agent-workflow/shared'
import type { UsageLedgerRecord } from '../domain/usageLedger'

export interface UsageRevisionReceipt {
  readonly fingerprint: string
  readonly outcome: 'applied' | 'diagnostic' | 'stale'
}
export type NativeRevisionResolution = ObservationNativeRevisionResolution
export interface UsageCaptureReceipt extends ObservationCaptureCommit {
  readonly sourceCursor: string
  readonly sourceId: string
  readonly resolutions: readonly NativeRevisionResolution[]
  readonly priorRevisionGap: boolean
}
export interface UsageLedgerScope {
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
    value: ObservationCaptureCommit,
    cursor: string,
    resolutions: readonly NativeRevisionResolution[],
  ): Promise<void>
  lockNativeRoot(nativeSource: string, root: string): Promise<void>
  nativeRecords(
    nativeSource: string,
    root: string,
    recordIds: readonly string[],
  ): Promise<{
    readonly items: readonly UsageLedgerRecord[]
    readonly truncated: boolean
  }>
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
