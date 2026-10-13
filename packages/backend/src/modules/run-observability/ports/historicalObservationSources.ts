import type {
  HistoricalObservationOwnerQuery,
  HistoricalNativeObservationReader,
  HistoricalObservationExecution,
  ObservationTaskFacts,
} from '@agent-workflow/shared'
import type { HistoricalNativeFacts } from './historicalNativeFacts'

/** Bootstrap composes actual owner queries; observability never reads another module's tables. */
export interface HistoricalObservationSources {
  readonly owners: readonly {
    readonly kind: HistoricalObservationExecution['sourceKind']
    readonly query: HistoricalObservationOwnerQuery
  }[]
  readonly native: {
    connectedRoots?(roots: readonly string[]): Promise<readonly string[] | null>
    open(input: {
      readonly referenceId: string
      readonly rootSessionId: string
    }): Promise<HistoricalNativeObservationReader | null>
    generation(): Promise<string | null>
  }
  readonly nativeFacts?: HistoricalNativeFacts
  task(id: string): Promise<ObservationTaskFacts | null>
}
