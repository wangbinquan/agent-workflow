import type {
  ObservationPriceIdentity,
  ObservationPricePageQuery,
  ObservationPriceVersion,
} from '@agent-workflow/shared'
import type { RuntimeObservationQueries } from '@/modules/runtime-management/public/queries'

export interface ObservationPriceScope {
  head(registrationId: string): Promise<number>
  receipt(
    registrationId: string,
    requestKey: string,
  ): Promise<
    | {
        readonly fingerprint: string
        readonly version: ObservationPriceVersion
      }
    | undefined
  >
  latest(
    registrationId: string,
    identity: ObservationPriceIdentity,
    acceptedAt?: number,
    maxRevision?: number,
  ): Promise<ObservationPriceVersion | undefined>
  append(version: ObservationPriceVersion, requestKey: string, fingerprint: string): Promise<void>
}
export interface ObservationPriceStore {
  heads(registrationIds: readonly string[]): Promise<ReadonlyMap<string, number>>
  history(
    registrationId: string,
    query: ObservationPricePageQuery,
  ): Promise<readonly ObservationPriceVersion[]>
  priceAt(
    registrationId: string,
    identity: ObservationPriceIdentity,
    acceptedAt: number,
    maxRevision?: number,
  ): Promise<ObservationPriceVersion | undefined>
  change<T>(registrationId: string, work: (scope: ObservationPriceScope) => Promise<T>): Promise<T>
}
export interface ObservationPricingDependencies {
  readonly store: ObservationPriceStore
  readonly runtimes: RuntimeObservationQueries
  readonly now: () => number
  readonly newId: () => string
}
