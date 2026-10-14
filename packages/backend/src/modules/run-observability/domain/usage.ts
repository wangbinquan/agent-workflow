// RFC-371 v2 §3–§4 — one call's usage is a replaceable snapshot split by the
// model the runtime actually reported. Unknown is never zero: an empty partial
// snapshot is "nothing reported yet", never a proven zero.

import type { ObservationUsageState } from '@agent-workflow/shared'

export interface UsageBuckets {
  readonly input: number
  readonly cacheRead: number
  readonly cacheWrite: number
  /** Includes reasoning. */
  readonly output: number
  /** Known subset of output; never added to totals again. */
  readonly reasoning: number
}

export interface ModelUsage extends UsageBuckets {
  /** Actual reported model; '' when the runtime did not attribute it. */
  readonly model: string
}

export interface ObservedUsage {
  readonly state: 'partial' | 'complete'
  readonly models: readonly ModelUsage[]
}

export const ZERO_BUCKETS: UsageBuckets = {
  input: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  reasoning: 0,
}

const count = (value: number): number => (Number.isSafeInteger(value) && value > 0 ? value : 0)

/** Merge duplicate model keys and drop invalid counts; reasoning never exceeds output. */
export function normalizeObservedUsage(usage: ObservedUsage): ObservedUsage {
  const byModel = new Map<string, ModelUsage>()
  for (const row of usage.models) {
    const model = row.model.trim().slice(0, 300)
    const previous = byModel.get(model)
    const output = count(row.output) + (previous?.output ?? 0)
    byModel.set(model, {
      model,
      input: count(row.input) + (previous?.input ?? 0),
      cacheRead: count(row.cacheRead) + (previous?.cacheRead ?? 0),
      cacheWrite: count(row.cacheWrite) + (previous?.cacheWrite ?? 0),
      output,
      reasoning: Math.min(output, count(row.reasoning) + (previous?.reasoning ?? 0)),
    })
  }
  return {
    state: usage.state === 'complete' ? 'complete' : 'partial',
    models: [...byModel.values()].sort((a, b) => a.model.localeCompare(b.model)),
  }
}

export function sumBuckets(rows: readonly UsageBuckets[]): UsageBuckets {
  return rows.reduce<UsageBuckets>(
    (sum, row) => ({
      input: sum.input + row.input,
      cacheRead: sum.cacheRead + row.cacheRead,
      cacheWrite: sum.cacheWrite + row.cacheWrite,
      output: sum.output + row.output,
      reasoning: sum.reasoning + row.reasoning,
    }),
    ZERO_BUCKETS,
  )
}

export function totalTokens(row: UsageBuckets): number {
  return row.input + row.cacheRead + row.cacheWrite + row.output
}

/** The persisted usage state of a call given its latest snapshot. */
export function usageStateOf(usage: ObservedUsage | null, ended: boolean): ObservationUsageState {
  if (usage?.state === 'complete') return 'complete'
  if (!usage || usage.models.length === 0) return ended ? 'none' : 'pending'
  return 'partial'
}
