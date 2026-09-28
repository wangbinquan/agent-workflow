import { ulid } from 'ulid'
import type { ProviderNeutralDatabase } from '@/db/query'
import type { RuntimeObservationQueries } from '@/modules/runtime-management/public/queries'
import { createObservationPricing } from '../application/pricing'
import { createObservationPriceStore } from '../infrastructure/pricingPersistence'

export function composeObservationPricing(input: {
  readonly db: ProviderNeutralDatabase
  readonly runtimes: RuntimeObservationQueries
}) {
  return createObservationPricing({
    store: createObservationPriceStore(input.db),
    runtimes: input.runtimes,
    now: Date.now,
    newId: ulid,
  })
}
