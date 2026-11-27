// RFC-616 §8.3 — pair every headline number with the same number of the
// comparison baseline. Whether a difference is an improvement is decided by
// PROCESS_METRIC_BETTER in shared, which the page reads too.

import type { ProcessCompared, ProcessMetricId } from '@agent-workflow/shared'

export type MetricValues = Partial<Record<ProcessMetricId, number | null>>

export function comparedMetrics(
  current: MetricValues,
  baseline: MetricValues | null,
): Partial<Record<ProcessMetricId, ProcessCompared>> {
  const result: Partial<Record<ProcessMetricId, ProcessCompared>> = {}
  for (const id of Object.keys(current) as ProcessMetricId[]) {
    result[id] = { value: current[id] ?? null, baseline: baseline?.[id] ?? null }
  }
  return result
}

/** The window of the same length that ends where the given one starts. */
export function previousWindow(from: number, to: number): { from: number; to: number } {
  return { from: Math.max(0, from - (to - from)), to: from }
}
