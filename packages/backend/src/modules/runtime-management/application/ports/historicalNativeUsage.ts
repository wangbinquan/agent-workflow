import type { HistoricalNativeObservationReader } from '@agent-workflow/shared'
export type {
  HistoricalNativeObservationIdentity as HistoricalNativePassIdentity,
  HistoricalNativeObservationPage as HistoricalNativePassPage,
  HistoricalNativeObservationReader as HistoricalNativePassReader,
} from '@agent-workflow/shared'

export interface HistoricalNativeUsageQuery {
  open(input: {
    readonly referenceId: string
    readonly rootSessionId: string
  }): Promise<HistoricalNativeObservationReader | null>
  generation(): Promise<string | null>
}
