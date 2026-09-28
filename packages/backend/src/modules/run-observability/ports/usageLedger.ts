import type { ObservationIngest } from '@agent-workflow/shared'
import type { UsageLedgerRecord } from '../domain/usageLedger'

export interface UsageRevisionReceipt {
  readonly fingerprint: string
  readonly outcome: 'applied' | 'diagnostic' | 'stale'
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
  ): Promise<void>
  advance(cursor: string): Promise<void>
}
export interface UsageLedgerStore {
  cursor(sourceId: string): Promise<string | null>
  change<T>(sourceId: string, work: (scope: UsageLedgerScope) => Promise<T>): Promise<T>
  records(
    taskId: string,
    page: { readonly limit: number; readonly after?: string },
  ): Promise<{ readonly items: readonly UsageLedgerRecord[]; readonly nextCursor?: string }>
}
