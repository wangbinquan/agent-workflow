import type { ProviderNeutralDatabase } from '@/db/query'
import type { ReportWorkspace } from './reportWorkspace'
export interface OriginalReportSnapshot {
  readonly executor: ProviderNeutralDatabase
  readonly workspace: ReportWorkspace
  readonly snapshotId: string
  readonly generationId: string
  readonly asOf: number
}
export interface ReportSnapshotSession {
  /** The original source snapshot and TEMP workspace share exactly one connection. */
  run<T>(work: (snapshot: OriginalReportSnapshot) => Promise<T>, signal?: AbortSignal): Promise<T>
}
