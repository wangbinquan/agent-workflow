// RFC-371 v2 §3.3 — price lines per (runtime registration, actual model).

import { ulid } from 'ulid'
import {
  OBSERVATION_BUILTIN_PROTOCOLS,
  observationBuiltinProtocol,
  observationMicroToRate,
  observationRateToMicro,
  type ObservationPrice,
  type ObservationPriceHistory,
  type ObservationPriceLine,
  type ObservationPricingDirectory,
  type SaveObservationPrice,
} from '@agent-workflow/shared'
import type { PriceVersion } from '../domain/pricing'
import type { CallStore } from './ports/callStore'
import type { PriceStore } from './ports/priceStore'
import type { RuntimeDirectoryPort } from './ports/runtimeDirectory'

export class ObservationPriceError extends Error {
  constructor(
    readonly code: 'runtime-not-found' | 'price-conflict',
    message: string,
  ) {
    super(message)
  }
}

export function priceView(version: PriceVersion): ObservationPrice {
  const rate = (micro: number | null) => (micro === null ? null : observationMicroToRate(micro))
  return {
    id: version.id,
    runtimeId: version.runtimeId,
    model: version.model,
    rates: {
      input: rate(version.inputMicro),
      cacheRead: rate(version.cacheReadMicro),
      cacheWrite: rate(version.cacheWriteMicro),
      output: rate(version.outputMicro),
    },
    effectiveFrom: version.effectiveFrom,
    createdAt: version.createdAt,
    createdBy: version.createdBy,
    note: version.note,
  }
}

const newest = (a: PriceVersion, b: PriceVersion) =>
  b.createdAt - a.createdAt || (b.id < a.id ? -1 : b.id > a.id ? 1 : 0)

const isBuiltinProtocol = (protocol: string | null): protocol is string =>
  protocol !== null && (OBSERVATION_BUILTIN_PROTOCOLS as readonly string[]).includes(protocol)

/** One runtime's price lines: its configured model, every model it reported, every priced model. */
function priceLines(
  runtimeId: string,
  configuredModel: string | null,
  seen: readonly { readonly runtimeId: string; readonly model: string; readonly calls: number }[],
  versions: readonly PriceVersion[],
): ObservationPriceLine[] {
  const lines = new Map<string, { calls: number; versions: PriceVersion[] }>()
  const line = (model: string) => {
    let found = lines.get(model)
    if (!found) {
      found = { calls: 0, versions: [] }
      lines.set(model, found)
    }
    return found
  }
  if (configuredModel) line(configuredModel)
  for (const row of seen) if (row.runtimeId === runtimeId) line(row.model).calls += row.calls
  for (const version of versions)
    if (version.runtimeId === runtimeId) line(version.model).versions.push(version)
  return [...lines.entries()]
    .map(([model, value]) => ({
      model,
      calls: value.calls,
      current: value.versions.length ? priceView([...value.versions].sort(newest)[0]!) : null,
    }))
    .sort((a, b) => b.calls - a.calls || a.model.localeCompare(b.model))
}

export interface ObservationPricing {
  directory(): Promise<ObservationPricingDirectory>
  history(runtimeId: string, model: string): Promise<ObservationPriceHistory>
  save(runtimeId: string, input: SaveObservationPrice, actorId: string): Promise<ObservationPrice>
}

export function createObservationPricing(deps: {
  readonly prices: PriceStore
  readonly calls: Pick<CallStore, 'runtimeModels'>
  readonly runtimes: RuntimeDirectoryPort
  readonly clock?: () => number
}): ObservationPricing {
  const clock = deps.clock ?? Date.now
  return {
    async directory() {
      const [{ runtimes }, versions, seen] = await Promise.all([
        deps.runtimes.directory(),
        deps.prices.all(),
        deps.calls.runtimeModels(),
      ])
      // Built-in runtimes appear once a call ran on one or a price line exists.
      const builtin = [
        ...new Set(
          [...seen.map((row) => row.runtimeId), ...versions.map((version) => version.runtimeId)]
            .filter((id) => isBuiltinProtocol(observationBuiltinProtocol(id)))
            .sort(),
        ),
      ]
      return {
        runtimes: [
          ...runtimes.map((runtime) => ({
            runtimeId: runtime.registrationId,
            name: runtime.name,
            protocol: runtime.protocol,
            builtin: false,
            configuredModel: runtime.model,
            models: priceLines(runtime.registrationId, runtime.model, seen, versions),
          })),
          ...builtin.map((runtimeId) => {
            const protocol = observationBuiltinProtocol(runtimeId)!
            return {
              runtimeId,
              name: protocol,
              protocol,
              builtin: true,
              configuredModel: null,
              models: priceLines(runtimeId, null, seen, versions),
            }
          }),
        ],
      }
    },

    async history(runtimeId, model) {
      const versions = await deps.prices.line(runtimeId, model)
      return { items: [...versions].sort(newest).map(priceView) }
    },

    async save(runtimeId, input, actorId) {
      if (!isBuiltinProtocol(observationBuiltinProtocol(runtimeId))) {
        const { runtimes } = await deps.runtimes.directory()
        if (!runtimes.some((runtime) => runtime.registrationId === runtimeId))
          throw new ObservationPriceError('runtime-not-found', 'Runtime registration not found')
      }
      const micro = (rate: string | null) => (rate === null ? null : observationRateToMicro(rate))
      const version: PriceVersion = {
        id: ulid(),
        runtimeId,
        model: input.model,
        inputMicro: micro(input.rates.input),
        cacheReadMicro: micro(input.rates.cacheRead),
        cacheWriteMicro: micro(input.rates.cacheWrite),
        outputMicro: micro(input.rates.output),
        effectiveFrom: input.effectiveFrom,
        createdAt: clock(),
        createdBy: actorId,
        note: input.note,
      }
      if ((await deps.prices.append(version, input.expectedLatestId)) === 'conflict')
        throw new ObservationPriceError(
          'price-conflict',
          'This price line changed since it was opened; reload before saving',
        )
      return priceView(version)
    },
  }
}
