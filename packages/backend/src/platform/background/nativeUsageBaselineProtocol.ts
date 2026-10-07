import type { ObservationNativePassCompletion } from '@agent-workflow/shared'
import type { NativeUsageReadBinding } from '@/modules/task-execution/public/types'
import type {
  ObservationReportWorkerSource,
  ObservationReportWorkerEvent,
  ObservationReportWorkerInput,
} from './observationReportProtocol'

export interface NativeUsageBaselineWorkerStart {
  readonly source: ObservationReportWorkerSource
  readonly binding: NativeUsageReadBinding
  readonly original: ObservationNativePassCompletion
}
export type NativeUsageBaselineRequest =
  | { readonly kind: 'open'; readonly input: NativeUsageBaselineWorkerStart }
  | { readonly kind: 'members'; readonly stepIds: readonly string[] }
  | { readonly kind: 'close' }
export type NativeUsageBaselineResult =
  | {
      readonly kind: 'opened'
      readonly original: ObservationNativePassCompletion
      readonly snapshotId: string
      readonly generationId: string
      readonly available: boolean
    }
  | { readonly kind: 'members'; readonly stepIds: readonly string[] }
  | { readonly kind: 'closed' }
export type NativeUsageBaselineWorkerInput =
  | {
      readonly kind: 'operation'
      readonly id: string
      readonly request: NativeUsageBaselineRequest
    }
  | Extract<ObservationReportWorkerInput, { kind: 'response' | 'cancel' }>
export type NativeUsageBaselineWorkerEvent =
  | { readonly kind: 'reply'; readonly id: string; readonly result: NativeUsageBaselineResult }
  | Extract<ObservationReportWorkerEvent, { kind: 'request' | 'failed' }>
