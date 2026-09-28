import { SaveObservationPriceSchema } from '@agent-workflow/shared'
import type { SaveObservationPrice, ObservationPriceVersion } from '@agent-workflow/shared'
import { ObservationPriceError } from '../domain/priceError'
import type { ObservationPricingDependencies } from '../ports/pricing'
import type { ObservationPricingCommands } from '../ports/pricingCommands'
import type { ObservationPricingQueries } from '../ports/pricingQueries'

async function savePrice(
  deps: ObservationPricingDependencies,
  registrationId: string,
  raw: SaveObservationPrice,
  createdBy: string,
): Promise<ObservationPriceVersion> {
  const parsed = SaveObservationPriceSchema.safeParse(raw)
  if (!parsed.success || !createdBy)
    throw new ObservationPriceError('invalid-price', 'Token price is invalid')
  const input = parsed.data,
    fingerprint = JSON.stringify(input)
  // Owner queries use the base pool: resolve before taking the price transaction's
  // connection. The immutable version stays keyed to this configuration revision.
  const runtime = (await deps.runtimes.directory()).runtimes.find(
    (row) => row.registrationId === registrationId,
  )
  return deps.store.change(registrationId, async (scope) => {
    const receipt = await scope.receipt(registrationId, input.requestKey)
    if (receipt) {
      if (receipt.fingerprint !== fingerprint)
        throw new ObservationPriceError(
          'request-conflict',
          'Request key already describes a different price',
        )
      return receipt.version
    }
    if (!runtime)
      throw new ObservationPriceError('runtime-not-found', 'Runtime registration no longer exists')
    if (
      runtime.configurationRevision !== input.configurationRevision ||
      runtime.protocol !== input.protocol
    ) {
      throw new ObservationPriceError(
        'runtime-changed',
        'Runtime configuration changed; keep the draft and review its current revision',
        { configurationRevision: runtime.configurationRevision },
      )
    }
    const revision = await scope.head(registrationId)
    if (revision !== input.expectedRevision)
      throw new ObservationPriceError(
        'price-conflict',
        'Price changed; keep the draft and review its current version',
        { revision },
      )
    const now = deps.now(),
      at = Date.parse(input.effectiveFrom)
    if (!Number.isFinite(at) || at < now)
      throw new ObservationPriceError(
        'invalid-price',
        'New prices cannot become effective before saving',
      )
    const previous = await scope.latest(registrationId, input)
    if (previous && at <= Date.parse(previous.effectiveFrom))
      throw new ObservationPriceError(
        'activation-conflict',
        'The new activation must follow the previous price for this exact model and condition',
      )
    const { requestKey, expectedRevision: _expected, ...price } = input
    const version: ObservationPriceVersion = {
      ...price,
      id: deps.newId(),
      registrationId,
      revision: revision + 1,
      effectiveFrom: new Date(at).toISOString(),
      createdAt: new Date(now).toISOString(),
      createdBy,
    }
    await scope.append(version, requestKey, fingerprint)
    return version
  })
}

export function createObservationPricing(deps: ObservationPricingDependencies): {
  readonly commands: ObservationPricingCommands
  readonly queries: ObservationPricingQueries
} {
  return {
    commands: { save: (id, input, createdBy) => savePrice(deps, id, input, createdBy) },
    queries: {
      runtimes: async () => {
        const { runtimes } = await deps.runtimes.directory()
        const heads = await deps.store.heads(runtimes.map((row) => row.registrationId))
        return {
          runtimes: runtimes.map((row) => ({
            ...row,
            pricingRevision: heads.get(row.registrationId) ?? 0,
          })),
        }
      },
      history: async (id, query) => {
        const rows = await deps.store.history(id, { ...query, limit: query.limit + 1 })
        const revision = (await deps.store.heads([id])).get(id) ?? 0
        const items = rows.slice(0, query.limit)
        return {
          items,
          revision,
          ...(rows.length > query.limit ? { nextBeforeRevision: items.at(-1)!.revision } : {}),
        }
      },
      priceAtAcceptance: async ({ registrationId, acceptedAt, ...identity }) => {
        if (!Number.isSafeInteger(acceptedAt))
          throw new ObservationPriceError('invalid-price', 'Invalid acceptance time')
        return (await deps.store.priceAt(registrationId, identity, acceptedAt)) ?? null
      },
    },
  }
}
