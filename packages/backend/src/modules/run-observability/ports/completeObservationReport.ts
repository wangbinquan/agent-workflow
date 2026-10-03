import type { Actor } from '@/auth/actor'
import type {
  ObservationOverviewQuery,
  ObservationTaskFacts,
  CompleteObservationSection,
  CompleteObservationReport,
  CompleteObservationReportHeader,
  CompleteObservationReportSummary,
  CompleteObservationFactSummary,
} from '@agent-workflow/shared'
import type { CompleteWorkingRows } from './completeWorkingRows'
import type { CompleteObservationSources } from './completeObservationSources'
import type { CompleteObservationTaskInput } from './completeObservationTask'
import type { CompleteSourceReceipt } from './completeReport'

export interface CompleteObservationReportRow {
  readonly section: CompleteObservationSection
  readonly parent: string | null
  readonly key: string
  readonly document: unknown
}
export interface CompleteObservationReportCount {
  readonly section: CompleteObservationSection
  readonly parent: string | null
  readonly total: string
}
export interface CompleteObservationCohortInput extends Omit<CompleteObservationTaskInput, 'task'> {
  readonly actor: Actor
  readonly query: ObservationOverviewQuery
  readonly task?: ObservationTaskFacts
  readonly agentName?: (id: string | null) => Promise<string | null>
}
export interface CompleteObservationCohortBuild {
  readonly summary: CompleteObservationReportSummary
  readonly rowsNamespace: string
  readonly countsNamespace: string
  readonly receiptsNamespace: string
  readonly taskSource: CompleteSourceReceipt
}
export type CompleteObservationTransferItem =
  | { readonly kind: 'row'; readonly row: CompleteObservationReportRow }
  | { readonly kind: 'count'; readonly count: CompleteObservationReportCount }
  | { readonly kind: 'receipt'; readonly key: string; readonly document: unknown }
export interface CompleteObservationTransferPage {
  readonly reportId: string
  readonly ordinal: string
  readonly previousDigest: string
  readonly digest: string
  readonly items: readonly CompleteObservationTransferItem[]
}
export interface CompleteObservationManifest {
  readonly reportId: string
  readonly owner: string
  readonly requestKey: string
  readonly pages: string
  readonly rows: string
  readonly counts: string
  readonly receipts: string
  readonly digest: string
  readonly header: CompleteObservationReportHeader
  readonly summary: CompleteObservationReportSummary | CompleteObservationFactSummary
}
export interface CompleteObservationSpool {
  seal(input: {
    readonly reportId: string
    readonly owner: string
    readonly requestKey: string
    readonly header: CompleteObservationReportHeader
    readonly summary: CompleteObservationReportSummary | CompleteObservationFactSummary
    readonly items: AsyncIterable<CompleteObservationTransferItem>
    readonly signal?: AbortSignal
  }): Promise<CompleteObservationManifest>
  pages(
    manifest: CompleteObservationManifest,
    signal?: AbortSignal,
  ): AsyncIterable<CompleteObservationTransferPage>
  remove(reportId: string, owner: string): Promise<void>
}
export interface CompleteObservationBuildContext {
  readonly rows: CompleteWorkingRows
  readonly sources: CompleteObservationSources
}
export interface CompleteObservationReportRequest {
  readonly actor: Actor
  readonly query: ObservationOverviewQuery
  readonly taskId?: string
  readonly refreshKey: string
}
export interface CompleteObservationStoredReport {
  readonly id: string
  readonly requestKey: string
  readonly request: CompleteObservationReportRequest
  readonly actorScope: string
  readonly generation: string
  readonly owner: string
  readonly report: CompleteObservationReport
  readonly manifest: CompleteObservationManifest | null
}
export type CompleteObservationBuildResult =
  | { readonly state: 'ready'; readonly manifest: CompleteObservationManifest }
  | {
      readonly state: 'not-ready'
      readonly gaps: readonly string[]
      readonly manifest?: CompleteObservationManifest
    }
