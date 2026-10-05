import type {
  CompleteObservationBuildResult,
  CompleteObservationStoredReport,
  NativeHistoryPreparation,
} from '@/modules/run-observability/public/participants'
import type { OriginalReportReadChannel } from '../persistence/reportSnapshotTypes'
import type { ReportWorkingRow } from '../persistence/reportWorkspace'

export type ObservationReportWorkerSource =
  | { readonly kind: 'sqlite-file'; readonly filename: string; readonly generationId: string }
  | {
      readonly kind: 'original-channel'
      readonly snapshotId: string
      readonly generationId: string
      readonly asOf: number
    }
export interface ObservationReportWorkerStart {
  readonly kind: 'start'
  readonly appHome: string
  readonly source: ObservationReportWorkerSource
  readonly report: CompleteObservationStoredReport
}
export interface NativeHistoryWorkerStart {
  readonly kind: 'native-history'
  readonly source: ObservationReportWorkerSource
  readonly value: NativeHistoryPreparation['value']
}
export type OriginalObservationWorkerStart = ObservationReportWorkerStart | NativeHistoryWorkerStart
export type OriginalObservationWorkerResult =
  | { readonly kind: 'result'; readonly result: CompleteObservationBuildResult }
  | { readonly kind: 'native-history-result'; readonly result: NativeHistoryPreparation | null }
export type ObservationReportRequest =
  | {
      readonly kind: 'read'
      readonly method: keyof OriginalReportReadChannel
      readonly statement: string
      readonly parameters: readonly unknown[]
    }
  | {
      readonly kind: 'write-working'
      readonly method: 'insert' | 'upsert'
      readonly namespace: string
      readonly rows: readonly ReportWorkingRow[]
    }
  | { readonly kind: 'get-working'; readonly namespace: string; readonly key: string }
  | {
      readonly kind: 'page-working'
      readonly namespace: string
      readonly after: string | null
      readonly size?: number
    }
  | { readonly kind: 'clear-working'; readonly namespace: string }
export type ObservationReportWorkerEvent =
  | { readonly kind: 'request'; readonly id: string; readonly request: ObservationReportRequest }
  | OriginalObservationWorkerResult
  | { readonly kind: 'failed'; readonly error: string }
export type ObservationReportWorkerInput =
  | ObservationReportWorkerStart
  | NativeHistoryWorkerStart
  | { readonly kind: 'cancel'; readonly reason: string }
  | { readonly kind: 'response'; readonly id: string; readonly ok: true; readonly value: unknown }
  | { readonly kind: 'response'; readonly id: string; readonly ok: false; readonly error: string }
