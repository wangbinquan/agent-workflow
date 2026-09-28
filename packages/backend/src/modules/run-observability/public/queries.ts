import type {
  ObservationPriceHistory,
  ObservationPriceIdentity,
  ObservationPricePageQuery,
  ObservationPriceVersion,
  ObservationPricingRuntime,
} from '@agent-workflow/shared'

export interface ObservationPricingQueries {
  runtimes(): Promise<{ readonly runtimes: readonly ObservationPricingRuntime[] }>
  history(
    registrationId: string,
    query: ObservationPricePageQuery,
  ): Promise<ObservationPriceHistory>
  /** Caller freezes the returned version at acceptance; no latest-price lookup at completion. */
  priceAtAcceptance(
    input: ObservationPriceIdentity & {
      readonly registrationId: string
      readonly acceptedAt: number
    },
  ): Promise<ObservationPriceVersion | null>
}
