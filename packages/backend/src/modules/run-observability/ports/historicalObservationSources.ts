import type {
  HistoricalObservationOwnerQuery,
  HistoricalNativeObservationReader,
  HistoricalObservationExecution,
  ObservationTaskFacts,
} from '@agent-workflow/shared'

/** Bootstrap composes actual owner queries; observability never reads another module's tables. */
export interface HistoricalObservationSources {
  readonly owners: readonly {
    readonly kind: HistoricalObservationExecution['sourceKind']
    readonly query: HistoricalObservationOwnerQuery
  }[]
  readonly native: {
    open(input: {
      readonly referenceId: string
      readonly rootSessionId: string
    }): Promise<HistoricalNativeObservationReader | null>
    generation(): Promise<string | null>
  }
  task(id: string): Promise<ObservationTaskFacts | null>
}
