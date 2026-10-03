import type { ProviderNeutralDatabase } from '@/db/query'
import type { AcceptedObservationInvocation, ObservationPriceVersion } from '@agent-workflow/shared'
import { sha256Hex } from '@/util/hash'
import { createInvocationValuation } from '../application/invocationValuation'
import { completeWorkingCache } from '../application/completeWorkingCache'
import type { CompleteWorkingRows } from '../ports/completeWorkingRows'
import { createObservationInvocationStore } from './invocationPersistence'
import { createObservationPriceStore } from './pricingPersistence'

/** Original accepted tariffs, with bounded memory and retained negative lookups. */
export function completeObservationValuation(input: {
  readonly db: ProviderNeutralDatabase
  readonly rows: CompleteWorkingRows
  readonly namespace: string
  readonly signal?: AbortSignal
}) {
  const invocations = createObservationInvocationStore(input.db),
    prices = createObservationPriceStore(input.db)
  const accepted = completeWorkingCache<{ value: AcceptedObservationInvocation | null }>(
    input.rows,
    input.namespace + '/accepted',
    input.signal,
  )
  const tariffs = completeWorkingCache<{ value: ObservationPriceVersion | null }>(
    input.rows,
    input.namespace + '/tariffs',
    input.signal,
  )
  return {
    value: createInvocationValuation(
      {
        async get(id) {
          const key = sha256Hex(id)
          let retained = await accepted.get(key)
          if (retained === undefined) {
            retained = { value: (await invocations.get(id)) ?? null }
            await accepted.put(key, retained)
          }
          return retained.value ?? undefined
        },
      },
      {
        async priceAt(...args) {
          const key = sha256Hex(JSON.stringify(args))
          let retained = await tariffs.get(key)
          if (retained === undefined) {
            retained = { value: (await prices.priceAt(...args)) ?? null }
            await tariffs.put(key, retained)
          }
          return retained.value ?? undefined
        },
      },
    ),
    async flush() {
      await accepted.flush()
      await tariffs.flush()
    },
  }
}
