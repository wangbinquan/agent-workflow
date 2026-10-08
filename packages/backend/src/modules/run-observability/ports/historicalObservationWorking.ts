import type {
  HistoricalObservationExecution,
  HistoricalNativeObservationPage,
  ObservationTaskFacts,
  CompleteHistoricalObservationExecution,
} from '@agent-workflow/shared'
import type { HistoricalObservationMatch } from '../domain/historicalObservationSelection'

export interface HistoricalWorkingExecution {
  readonly execution: HistoricalObservationExecution
  readonly parentTask: ObservationTaskFacts | null
  readonly scopeMatch: HistoricalObservationMatch
  readonly timeBasis: CompleteHistoricalObservationExecution['timeBasis']
  readonly cohortAt: number | null
}
export interface HistoricalWorkingNativeRecord {
  readonly nativeSource: string
  readonly sourceGeneration: string
  readonly step: HistoricalNativeObservationPage['steps'][number]
  readonly fingerprint: string
  readonly conflicting: boolean
}
