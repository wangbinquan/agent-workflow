// RFC-616 §7 — the statistics every process metric shares. No sample means
// null, never zero: an empty percentile and a 0/0 rate both say "no data".

import type { ProcessStat } from '@agent-workflow/shared'
import { nearestRank } from '../statistics'

export const EMPTY_STAT: ProcessStat = { n: 0, p50: null, p90: null, mean: null }

/** Median, P90 (nearest rank, like the rest of run observation) and mean of a sample. */
export function statOf(values: readonly number[]): ProcessStat {
  if (values.length === 0) return EMPTY_STAT
  const sorted = [...values].sort((a, b) => a - b)
  return {
    n: sorted.length,
    p50: nearestRank(sorted, 0.5),
    p90: nearestRank(sorted, 0.9),
    mean: Math.round(sum(sorted) / sorted.length),
  }
}

export function sum(values: readonly number[]): number {
  let total = 0
  for (const value of values) total += value
  return total
}

export function median(values: readonly number[]): number | null {
  return nearestRank(
    [...values].sort((a, b) => a - b),
    0.5,
  )
}

/** Arithmetic mean; null without a sample. */
export function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : sum(values) / values.length
}

/** A rate; null when the denominator is zero. */
export function ratio(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null
}

/** Split `total` across `weights` so the integer parts add up to `total` exactly. */
export function apportion(total: number, weights: readonly number[]): number[] {
  const weightSum = sum(weights)
  if (total <= 0 || weightSum <= 0) return weights.map(() => 0)
  const exact = weights.map((weight) => (total * weight) / weightSum)
  const parts = exact.map((value) => Math.floor(value))
  let rest = total - sum(parts)
  // Largest remainder first; ties resolve by position, which is deterministic.
  const order = exact
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index)
  for (const { index } of order) {
    if (rest <= 0) break
    parts[index] = parts[index]! + 1
    rest--
  }
  return parts
}
