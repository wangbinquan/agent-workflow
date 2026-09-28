import type { ObservationPriceVersion, SaveObservationPrice } from '@agent-workflow/shared'

export interface ObservationPricingCommands {
  save(
    registrationId: string,
    input: SaveObservationPrice,
    createdBy: string,
  ): Promise<ObservationPriceVersion>
}
