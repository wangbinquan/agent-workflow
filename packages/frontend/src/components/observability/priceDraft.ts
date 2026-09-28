import { SaveObservationPriceSchema } from '@agent-workflow/shared'
import type { ObservationPricingRuntime, SaveObservationPrice } from '@agent-workflow/shared'

export const PRICE_BUCKETS = ['input', 'cacheRead', 'cacheWrite', 'output'] as const
export interface ObservationPriceDraft {
  provider: string
  model: string
  condition: string
  effectiveFrom: string
  sourceNote: string
  input: string
  cacheRead: string
  cacheWrite: string
  output: string
}
export function initialPriceDraft(
  runtime: ObservationPricingRuntime,
  now: number,
): ObservationPriceDraft {
  const date = new Date(now + 300_000)
  return {
    provider: '',
    model: runtime.model ?? '',
    condition: '',
    sourceNote: '',
    input: '',
    cacheRead: '',
    cacheWrite: '',
    output: '',
    effectiveFrom: new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
      .toISOString()
      .slice(0, 16),
  }
}
export interface SubmittedPrice {
  readonly signature: string
  readonly input: SaveObservationPrice
}
export function preparePriceRequest(
  draft: ObservationPriceDraft,
  runtime: ObservationPricingRuntime,
  revision: number,
  previous: SubmittedPrice | undefined,
  now: number,
  newKey: () => string,
): {
  receipt?: SubmittedPrice
  errors: Readonly<Record<string, string>>
} {
  const signature = JSON.stringify({
    draft,
    revision,
    registrationId: runtime.registrationId,
    configurationRevision: runtime.configurationRevision,
    protocol: runtime.protocol,
  })
  if (previous?.signature === signature) return { receipt: previous, errors: {} }
  const at = new Date(draft.effectiveFrom)
  const parsed = SaveObservationPriceSchema.safeParse({
    expectedRevision: revision,
    requestKey: newKey(),
    configurationRevision: runtime.configurationRevision,
    protocol: runtime.protocol,
    provider: draft.provider,
    model: draft.model,
    condition: draft.condition || null,
    currency: 'CNY',
    rates: {
      input: draft.input || null,
      cacheRead: draft.cacheRead || null,
      cacheWrite: draft.cacheWrite || null,
      output: draft.output || null,
    },
    effectiveFrom: Number.isFinite(at.getTime()) ? at.toISOString() : '',
    sourceNote: draft.sourceNote,
  })
  const errors: Record<string, string> = {}
  if (!parsed.success)
    for (const issue of parsed.error.issues)
      errors[String(issue.path.at(-1) ?? '')] = 'observationPricing.invalid'
  if (!Number.isFinite(at.getTime()) || at.getTime() < now)
    errors.effectiveFrom = 'observationPricing.future'
  return Object.keys(errors).length || !parsed.success
    ? { errors }
    : { receipt: { signature, input: parsed.data }, errors }
}
