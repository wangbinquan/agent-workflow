import type { HistoricalWorkingExecution } from './historicalObservationWorking'
import type { CompleteWorkingRows } from './completeWorkingRows'

/** Optional TEMP operations preserve every row while avoiding a round trip for every namespace. */
export interface HistoricalPreparationWorkingRows extends CompleteWorkingRows {
  copyNamespacePrefix?(from: string, to: string, excluded: readonly string[]): Promise<void>
  clearNamespacePrefix?(prefix: string): Promise<void>
}

/** Original raw populations and indices; selected-range decisions are never cached. */
export interface HistoricalObservationStage {
  readonly namespace: string
  readonly executionsNamespace: string
  readonly nativeRecordsNamespace: string
  readonly receiptsNamespace: string
  readonly sourceRows: string
  readonly candidateIndex?: true
}
export interface HistoricalObservationPreparationCache {
  read(): Promise<HistoricalObservationStage | null>
  retain(stage: HistoricalObservationStage): Promise<void>
}
export interface HistoricalObservationPreparationVersion {
  readonly algorithm: 'historical-preparation-20261012-v1'
  readonly sourceKey: string
  readonly cacheKey: string
  readonly sourceRows: string
  readonly groups: string
  readonly groupDigest: string
  /** Includes the complete group index and every original data row. */
  readonly rows: string
  readonly contentDigest: string
}
export interface HistoricalObservationPreparationGroup {
  readonly rows: string
  readonly digest: string
}
export type HistoricalObservationPreparationExecution = Pick<
  HistoricalWorkingExecution,
  'execution' | 'parentTask'
>
export type HistoricalObservationPreparationItem =
  | { readonly kind: 'version'; readonly version: HistoricalObservationPreparationVersion }
  | {
      readonly kind: 'row'
      readonly cacheKey: string
      readonly namespace: string
      readonly key: string
      readonly document: unknown
    }
