// RFC-371 v2 §5 — the run observation HTTP contract on the client side.
import type {
  ObservationAgentPage,
  ObservationModelPage,
  ObservationOverview,
  ObservationPrice,
  ObservationPriceHistory,
  ObservationPricingDirectory,
  ObservationSystemPage,
  ObservationTaskDetail,
  ObservationTaskPage,
  SaveObservationPrice,
} from '@agent-workflow/shared'
import { api } from '@/api/client'

export interface ObservationWindow {
  readonly from: number
  readonly to: number
  readonly tzOffset: number
}

export const OBSERVATION_QUERY = ['observability'] as const
export const PRICING_QUERY = ['observability', 'pricing'] as const

const window = (value: ObservationWindow) => ({
  from: value.from,
  to: value.to,
  tzOffset: value.tzOffset,
})

export const observationApi = {
  overview: (value: ObservationWindow, signal?: AbortSignal) =>
    api.get<ObservationOverview>('/api/observability/overview', window(value), signal),
  tasks: (
    value: ObservationWindow,
    filter: { readonly q?: string; readonly status?: string; readonly cursor?: string },
    signal?: AbortSignal,
  ) =>
    api.get<ObservationTaskPage>(
      '/api/observability/tasks',
      { from: value.from, to: value.to, q: filter.q, status: filter.status, cursor: filter.cursor },
      signal,
    ),
  task: (taskId: string, signal?: AbortSignal) =>
    api.get<ObservationTaskDetail>(
      `/api/observability/tasks/${encodeURIComponent(taskId)}`,
      undefined,
      signal,
    ),
  agents: (value: ObservationWindow, signal?: AbortSignal) =>
    api.get<ObservationAgentPage>('/api/observability/agents', window(value), signal),
  models: (value: ObservationWindow, signal?: AbortSignal) =>
    api.get<ObservationModelPage>('/api/observability/models', window(value), signal),
  system: (
    value: ObservationWindow,
    filter: { readonly kind?: string; readonly cursor?: string },
    signal?: AbortSignal,
  ) =>
    api.get<ObservationSystemPage>(
      '/api/observability/system',
      { from: value.from, to: value.to, kind: filter.kind, cursor: filter.cursor },
      signal,
    ),
}

export const pricingApi = {
  directory: (signal?: AbortSignal) =>
    api.get<ObservationPricingDirectory>('/api/observability/pricing', undefined, signal),
  history: (runtimeId: string, model: string, signal?: AbortSignal) =>
    api.get<ObservationPriceHistory>(
      `/api/observability/pricing/${encodeURIComponent(runtimeId)}/history`,
      { model },
      signal,
    ),
  save: (runtimeId: string, input: SaveObservationPrice) =>
    api.post<ObservationPrice>(
      `/api/observability/pricing/${encodeURIComponent(runtimeId)}`,
      input,
    ),
}
