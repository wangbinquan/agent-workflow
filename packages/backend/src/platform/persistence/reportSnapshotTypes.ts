import type { ProviderNeutralDatabase } from '@/db/query'
import type { ReportWorkspace } from './reportWorkspace'
export interface OriginalReportReadChannel {
  objects(
    statement: string,
    parameters: readonly unknown[],
  ): Promise<readonly Record<string, unknown>[]>
  values(
    statement: string,
    parameters: readonly unknown[],
  ): Promise<readonly (readonly unknown[])[]>
}
/** A derived report reader fence on its original reserved connection. */
export interface OriginalReportLease {
  readonly id: string
  readonly owner: string
  readonly generation: string
}
export interface OriginalReportSnapshot {
  readonly executor: ProviderNeutralDatabase
  readonly workspace: ReportWorkspace
  readonly snapshotId: string
  readonly generationId: string
  readonly asOf: number
  readonly readChannel?: OriginalReportReadChannel
}
export interface ReportSnapshotSession {
  /** The original source snapshot and TEMP workspace share exactly one connection. */
  run<T>(
    work: (snapshot: OriginalReportSnapshot) => Promise<T>,
    signal?: AbortSignal,
    lease?: OriginalReportLease,
  ): Promise<T>
}
