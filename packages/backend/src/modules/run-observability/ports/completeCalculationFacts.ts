import type { HistoricalNativeSourceProof } from '@/modules/runtime-management/public/participants'
import type { CompleteObservationTaskNumeric } from './completeObservationTask'

export interface CompleteCalculationSourceProof {
  readonly version: 1
  readonly generationId: string
  readonly relations: readonly { readonly sourceId: string; readonly revision: string }[]
}
export interface CompleteCalculationContext {
  readonly source: CompleteCalculationSourceProof
  readonly native: HistoricalNativeSourceProof
  readonly actorScope: string
}
export interface CompleteTaskCalculationVersion {
  readonly algorithm: 'task-numeric-20261012-v1'
  readonly cacheKey: string
  readonly sourceKey: string
  /** Namespace properties are structural relative names; original receipts keep original identities. */
  readonly numeric: CompleteObservationTaskNumeric
  readonly groups: readonly {
    readonly namespace: string
    readonly rows: string
    readonly digest: string
  }[]
  readonly rows: string
  readonly contentDigest: string
}
export type CompleteCalculationFactItem =
  | { readonly kind: 'version'; readonly version: CompleteTaskCalculationVersion }
  | {
      readonly kind: 'row'
      readonly cacheKey: string
      readonly namespace: string
      readonly key: string
      readonly document: unknown
    }
export interface CompleteCalculationFactPage {
  readonly reportId: string
  readonly ordinal: string
  readonly previousDigest: string
  readonly digest: string
  readonly items: readonly CompleteCalculationFactItem[]
}
export interface CompleteCalculationFactManifest {
  readonly reportId: string
  readonly owner: string
  readonly context: CompleteCalculationContext
  readonly packets: string
  readonly versions: string
  readonly rows: string
  readonly digest: string
}
export interface CompleteCalculationFactSpool {
  seal(input: {
    readonly reportId: string
    readonly owner: string
    readonly context: CompleteCalculationContext
    readonly items: AsyncIterable<CompleteCalculationFactItem>
    readonly signal?: AbortSignal
  }): Promise<CompleteCalculationFactManifest>
  pages(
    manifest: CompleteCalculationFactManifest,
    signal?: AbortSignal,
  ): Iterable<CompleteCalculationFactPage>
}
