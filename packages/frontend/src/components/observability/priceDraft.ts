// RFC-371 v2 §3.3 — a price-line draft: four CNY rates per million tokens
// (empty is unknown, never free), an optional future effective time, and the
// newest version the draft was based on (compare-and-set on save).
import type { ObservationPrice, SaveObservationPrice } from '@agent-workflow/shared'

export const PRICE_BUCKETS = ['input', 'cacheRead', 'cacheWrite', 'output'] as const
export type PriceBucket = (typeof PRICE_BUCKETS)[number]

export interface PriceDraft {
  readonly model: string
  readonly input: string
  readonly cacheRead: string
  readonly cacheWrite: string
  readonly output: string
  /** `datetime-local` value; empty applies on save. */
  readonly effectiveFrom: string
  readonly note: string
}

const RATE = /^(0|[1-9]\d{0,8})(\.\d{1,6})?$/
/** A few seconds of slack between picking "now" and pressing save. */
const PAST_TOLERANCE_MS = 60_000

export function initialPriceDraft(model: string, current: ObservationPrice | null): PriceDraft {
  return {
    model,
    input: current?.rates.input ?? '',
    cacheRead: current?.rates.cacheRead ?? '',
    cacheWrite: current?.rates.cacheWrite ?? '',
    output: current?.rates.output ?? '',
    effectiveFrom: '',
    note: '',
  }
}

export type PriceDraftErrors = Partial<Record<'model' | PriceBucket | 'effectiveFrom', string>>

export function preparePrice(
  draft: PriceDraft,
  expectedLatestId: string | null,
  now: number,
): { readonly errors: PriceDraftErrors; readonly input?: SaveObservationPrice } {
  const errors: PriceDraftErrors = {}
  const model = draft.model.trim()
  if (!model) errors.model = 'observationPricing.invalidModel'
  const rates = {} as Record<PriceBucket, string | null>
  for (const bucket of PRICE_BUCKETS) {
    const value = draft[bucket].trim()
    if (value === '') rates[bucket] = null
    else if (RATE.test(value)) rates[bucket] = value
    else errors[bucket] = 'observationPricing.invalidRate'
  }
  let effectiveFrom = now
  if (draft.effectiveFrom !== '') {
    const at = new Date(draft.effectiveFrom).getTime()
    if (!Number.isFinite(at) || at < now - PAST_TOLERANCE_MS)
      errors.effectiveFrom = 'observationPricing.invalidEffectiveFrom'
    else effectiveFrom = Math.max(at, now)
  }
  if (Object.keys(errors).length > 0) return { errors }
  return {
    errors,
    input: {
      model,
      rates,
      effectiveFrom,
      note: draft.note.trim(),
      expectedLatestId,
    },
  }
}
