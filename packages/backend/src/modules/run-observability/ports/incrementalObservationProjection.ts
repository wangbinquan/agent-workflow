import type {
  IncrementalObservationContributionFold,
  IncrementalObservationFold,
} from '../domain/incrementalObservationFold'

/** Created in the source transaction. IDs are identities, never a committed
 * high-water mark: each individual work item must be completed. */
export interface IncrementalObservationWork {
  readonly id: string
  /** The union of old/new connected scope keys. Ownership moving between roots
   * must withdraw and add within one version, not two visible transactions. */
  readonly components: readonly string[]
  readonly source: string
  readonly revision: string
  readonly preparationToken?: string
  readonly baseRevision?: string
  readonly asOf?: number
  readonly retryNative?: boolean
}
export interface IncrementalObservationContribution {
  readonly key: string
  readonly component: string
  /** Already allocated by the original complete ancestry/ownership rules. */
  readonly fold: IncrementalObservationContributionFold
  /** Stable dimension/time membership, including precise boundary fact indexes. */
  readonly descriptors?: Readonly<Record<string, string>>
  readonly aggregates: readonly string[]
  readonly detail: unknown
}
export interface IncrementalObservationVersion {
  readonly revision: string
  readonly asOf: number
}
export interface IncrementalObservationProjectionTransaction {
  /** Lock the projection head; serializes consumers, not source producers. */
  head(): Promise<IncrementalObservationVersion>
  /** The source proof must remain stable throughout this transaction. */
  sourceUnchanged(work: IncrementalObservationWork): Promise<boolean>
  coverageChanged?(work: IncrementalObservationWork): Promise<boolean>
  /** Complete, strictly key-ordered enumeration at the transaction's snapshot.
   * A packet size is a transfer budget; only the iterator's EOF ends population. */
  previous(work: IncrementalObservationWork): AsyncIterable<IncrementalObservationContribution>
  putContribution(
    key: string,
    contribution: IncrementalObservationContribution | null,
    version: IncrementalObservationVersion,
  ): Promise<void>
  retainDescriptors?(descriptors: Readonly<Record<string, string>>): Promise<void>
  aggregate(key: string): Promise<IncrementalObservationFold | null>
  putAggregate(
    key: string,
    value: IncrementalObservationFold,
    version: IncrementalObservationVersion,
  ): Promise<void>
  complete(work: IncrementalObservationWork): Promise<void>
  publish(version: IncrementalObservationVersion): Promise<void>
}
export interface IncrementalObservationProjectionStore {
  /** Lists unfinished durable work. A failed/late transaction cannot be skipped
   * by advancing an auto-increment cursor. */
  pending(packetSize: number): Promise<readonly IncrementalObservationWork[]>
  change<T>(work: (tx: IncrementalObservationProjectionTransaction) => Promise<T>): Promise<T>
}
export interface IncrementalObservationComponentSource {
  /** Read only the affected connected ownership/scope component. Includes its
   * lifecycle/capture/gap contributors. Reject an incomplete enumeration; source
   * gaps belong in folds and never authorize deleting an unobserved old tail. */
  contributions(
    tx: IncrementalObservationProjectionTransaction,
    work: IncrementalObservationWork,
  ): AsyncIterable<IncrementalObservationContribution>
}
