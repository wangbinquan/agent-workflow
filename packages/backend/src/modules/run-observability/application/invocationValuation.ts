import type { ObservationTokenUsage } from '@agent-workflow/shared'
import { valueTokenUsage, type CnyValuation } from '../domain/cnyPricing'
import { ObservationInvocationError } from '../domain/invocationError'
import type { ObservationInvocationStore } from '../ports/invocations'
import type { ObservationPriceStore } from '../ports/pricing'

export type InvocationValuation =
  | {
      readonly currency: 'CNY'
      readonly availability:
        | 'platform-managed'
        | 'registration-unknown'
        | 'model-unknown'
        | 'unpriced'
      readonly amountDecimal: null
      readonly priceVersionId: null
    }
  | {
      readonly currency: 'CNY'
      readonly availability: 'priced'
      readonly amountDecimal: string | null
      readonly priceVersionId: string
      readonly completeness: CnyValuation['completeness']
      readonly missing: CnyValuation['missing']
    }

/** Local estimation always uses the accepted catalogue. CS never falls through to local tariffs. */
export function createInvocationValuation(
  invocations: ObservationInvocationStore,
  prices: ObservationPriceStore,
) {
  return async (input: {
    readonly invocationId: string
    readonly model: { readonly provider: string | null; readonly id: string } | null
    readonly condition: string | null
    readonly usage: ObservationTokenUsage
  }): Promise<InvocationValuation> => {
    const accepted = await invocations.get(input.invocationId)
    if (!accepted)
      throw new ObservationInvocationError('invocation-not-found', 'Invocation was not accepted')
    const unavailable = (
      availability: 'platform-managed' | 'registration-unknown' | 'model-unknown' | 'unpriced',
    ): InvocationValuation => ({
      currency: 'CNY',
      availability,
      amountDecimal: null,
      priceVersionId: null,
    })
    if (accepted.authority.kind === 'crewstation') return unavailable('platform-managed')
    const runtime = accepted.authority.runtime
    if (runtime === null) return unavailable('registration-unknown')
    if (input.model === null || input.model.provider === null) return unavailable('model-unknown')
    const price = await prices.priceAt(
      runtime.registrationId,
      {
        configurationRevision: runtime.configurationRevision,
        protocol: runtime.protocol,
        provider: input.model.provider,
        model: input.model.id,
        condition: input.condition,
      },
      accepted.acceptedAt,
      accepted.priceBookRevision!,
    )
    if (!price) return unavailable('unpriced')
    const result = valueTokenUsage(input.usage, price.rates)
    return {
      currency: 'CNY',
      availability: 'priced',
      priceVersionId: price.id,
      amountDecimal: result.completeness === 'unpriced' ? null : result.knownAmount,
      completeness: result.completeness,
      missing: result.missing,
    }
  }
}
