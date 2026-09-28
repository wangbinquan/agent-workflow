import { api } from '@/api/client'
import type {
  ObservationPriceHistory,
  ObservationPriceVersion,
  ObservationPricingRuntime,
  SaveObservationPrice,
} from '@agent-workflow/shared'

export const PRICING_QUERY = ['observability', 'pricing'] as const
const root = '/api/observability/pricing/runtimes'
export const priceVersionsPath = (id: string) => root + '/' + encodeURIComponent(id) + '/versions'
export const runtimePrices = {
  directory: (signal?: AbortSignal) =>
    api.get<{ runtimes: ObservationPricingRuntime[] }>(root, undefined, signal),
  history: (id: string, before?: number, signal?: AbortSignal) =>
    api.get<ObservationPriceHistory>(
      priceVersionsPath(id),
      { limit: 20, ...(before === undefined ? {} : { beforeRevision: before }) },
      signal,
    ),
  save: (id: string, input: SaveObservationPrice) =>
    api.post<ObservationPriceVersion>(priceVersionsPath(id), input),
}
