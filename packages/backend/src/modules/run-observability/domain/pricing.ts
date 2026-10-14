// RFC-371 v2 §3.3–§3.4 — append-only CNY price lines and exact integer costing.
//
// A call uses the version of its (runtime, model) line with the greatest
// (effectiveFrom, createdAt) among those effective AND created no later than the
// call started. Versions are immutable, so a call's price never changes: a new
// price only affects calls accepted after it was saved, even when back-dated.

import type { ObservationCostState } from '@agent-workflow/shared'
import type { UsageBuckets } from './usage'

export interface PriceVersion {
  readonly id: string
  readonly runtimeId: string
  readonly model: string
  /** CNY micro-yuan per million tokens; null is unknown, never free. */
  readonly inputMicro: number | null
  readonly cacheReadMicro: number | null
  readonly cacheWriteMicro: number | null
  readonly outputMicro: number | null
  readonly effectiveFrom: number
  readonly createdAt: number
  readonly createdBy: string
  readonly note: string
}

export function selectPrice(
  versions: readonly PriceVersion[],
  startedAt: number,
): PriceVersion | null {
  let best: PriceVersion | null = null
  for (const version of versions) {
    if (version.effectiveFrom > startedAt || version.createdAt > startedAt) continue
    if (
      !best ||
      version.effectiveFrom > best.effectiveFrom ||
      (version.effectiveFrom === best.effectiveFrom && version.createdAt > best.createdAt) ||
      (version.effectiveFrom === best.effectiveFrom &&
        version.createdAt === best.createdAt &&
        version.id > best.id)
    )
      best = version
  }
  return best
}

export interface ModelCost {
  /** Nano-yuan of the priced buckets; null when nothing could be priced. */
  readonly costNano: number | null
  /** Every bucket with tokens had a known rate. */
  readonly complete: boolean
}

/** tokens × micro-yuan-per-million ÷ 1000 = nano-yuan, rounded half up, exact in BigInt. */
export function modelCost(usage: UsageBuckets, price: PriceVersion | null): ModelCost {
  const buckets: readonly [number, number | null | undefined][] = [
    [usage.input, price?.inputMicro],
    [usage.cacheRead, price?.cacheReadMicro],
    [usage.cacheWrite, price?.cacheWriteMicro],
    [usage.output, price?.outputMicro],
  ]
  let product = 0n,
    priced = false,
    complete = price !== null
  for (const [tokens, rate] of buckets) {
    if (tokens <= 0) continue
    if (rate === null || rate === undefined) {
      complete = false
      continue
    }
    product += BigInt(tokens) * BigInt(rate)
    priced = true
  }
  if (!price) return { costNano: null, complete: false }
  if (!priced && !complete) return { costNano: null, complete: false }
  return { costNano: Number((product + 500n) / 1000n), complete }
}

export function callCostState(
  rows: readonly { readonly tokens: number; readonly cost: ModelCost }[],
): { readonly costNano: number; readonly costState: ObservationCostState } {
  const relevant = rows.filter((row) => row.tokens > 0)
  const costNano = relevant.reduce((sum, row) => sum + (row.cost.costNano ?? 0), 0)
  if (relevant.length === 0) return { costNano: 0, costState: 'none' }
  if (relevant.every((row) => row.cost.complete)) return { costNano, costState: 'priced' }
  if (relevant.every((row) => row.cost.costNano === null))
    return { costNano: 0, costState: 'unpriced' }
  return { costNano, costState: 'partial' }
}
